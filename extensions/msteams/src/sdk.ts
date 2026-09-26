import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readSecretFile } from "openclaw/plugin-sdk/secret-file";
import { normalizeBotFrameworkServiceUrl } from "./bot-framework-service-url.js";
import type { MSTeamsCloudName } from "./cloud.js";
import { resolveMSTeamsPrivateQaRuntime } from "./qa/private-runtime.js";
import { MSTEAMS_REQUEST_TIMEOUT_MS } from "./request-timeout.js";
import { msteamsConnectorHandoffInterceptor } from "./send-handoff.js";
import type { MSTeamsCredentials, MSTeamsFederatedCredentials } from "./token.js";
import { buildOpenClawUserAgentFragment } from "./user-agent.js";

type MSTeamsHttpServerAdapter =
  import("@microsoft/teams.apps/dist/http/adapter.js").IHttpServerAdapter;

/**
 * Borrow the SDK's `IRoutes` map so `app.on("<route-name>", (ctx) => …)`
 * gets route-name validation and ctx inference. We define our own `on`
 * signature instead of borrowing the SDK's free function (which is bound to
 * `this: App<TPlugin>`), because our `MSTeamsApp` is a structural alias —
 * not a real `App` instance.
 */
type MSTeamsRoutes = import("@microsoft/teams.apps/dist/routes/index.js").IRoutes;

/** Adaptive-card action response shape, re-exported for typed `card.action` handlers. */
export type MSTeamsCardActionResponse =
  import("@microsoft/teams.api/dist/models/adaptive-card/adaptive-card-action-response.js").AdaptiveCardActionResponse;

type SigninEventCtx = import("@microsoft/teams.apps/dist/contexts/index.js").IActivitySignInContext;

type MSTeamsAppOn = <Name extends keyof MSTeamsRoutes>(
  name: Name,
  cb: Exclude<MSTeamsRoutes[Name], undefined>,
) => MSTeamsApp;

/** Teams SDK surface consumed by the plugin, with SDK-owned route and token contracts. */
export type MSTeamsApp = {
  send(conversationId: string, activity: unknown): Promise<{ id?: string }>;
  /**
   * Threaded variant of `send` for channel/groupchat replies. The SDK builds
   * the threaded conversation id internally (`${conversationId};messageid=${messageId}`)
   * via its `toThreadedConversationId` helper, so we don't have to reproduce
   * Teams' URL format on our side.
   */
  reply(conversationId: string, messageId: string, activity: unknown): Promise<{ id?: string }>;
  on: MSTeamsAppOn;
  event(name: "signin", cb: (ctx: SigninEventCtx) => void | Promise<void>): MSTeamsApp;
  process: import("@microsoft/teams.apps").App["process"];
  initialize(): Promise<void>;
  tokenProvider: Pick<import("@microsoft/teams.api").ITokenProvider, "getAppToken">;
  credentials?: Pick<import("@microsoft/teams.api").Credentials, "tenantId">;
  cloud?: {
    botScope?: string;
    graphScope?: string;
  };
  api: {
    serviceUrl?: string;
    teams: {
      getById(teamId: string): Promise<{ aadGroupId?: string }>;
    };
    conversations: {
      activities(conversationId: string): {
        create(activity: unknown): Promise<{ id?: string }>;
        update(activityId: string, activity: unknown): Promise<unknown>;
        delete(activityId: string): Promise<unknown>;
      };
    };
  };
};

/**
 * Token provider compatible with the existing codebase, wrapping the Teams
 * SDK App's public token provider.
 */
type MSTeamsTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

type AzureAccessToken = {
  token?: string;
} | null;

type AzureTokenCredential = {
  getToken: (scope: string | string[]) => Promise<AzureAccessToken>;
};

type AzureIdentityModule = {
  ClientCertificateCredential: new (
    tenantId: string,
    clientId: string,
    options: { certificate: string },
  ) => AzureTokenCredential;
};

const AZURE_IDENTITY_MODULE = "@azure/identity";

const loadAzureIdentity = createLazyRuntimeModule(
  () => import(AZURE_IDENTITY_MODULE) as Promise<AzureIdentityModule>,
);

const loadSdkModules = createLazyRuntimeModule(() =>
  Promise.all([import("@microsoft/teams.apps"), import("@microsoft/teams.api")]).then(
    ([apps, api]) => ({
      App: apps.App,
      ExpressAdapter: apps.ExpressAdapter,
      cloudFromName: api.cloudFromName,
    }),
  ),
);

/**
 * Lazily construct an ExpressAdapter that the Teams SDK App can register its
 * routes on. The dynamic import keeps the SDK bundle off the hot startup path
 * when msteams is disabled; the structural return type matches what
 * `loadMSTeamsSdkWithAuth` accepts as its `httpServerAdapter` option.
 */
export async function createMSTeamsExpressAdapter(
  serverOrApp: ConstructorParameters<
    typeof import("@microsoft/teams.apps/dist/http/express-adapter.js").ExpressAdapter
  >[0],
): Promise<MSTeamsHttpServerAdapter> {
  const { ExpressAdapter } = await loadSdkModules();
  return new ExpressAdapter(serverOrApp);
}

/**
 * Options for creating a Teams SDK App instance.
 */
type CreateMSTeamsAppOptions = {
  /**
   * HTTP server adapter to use. When an Express app is available (monitor
   * mode), pass an ExpressAdapter so the SDK registers routes and handles
   * JWT validation. When omitted, the SDK creates a default ExpressAdapter
   * (no server starts until app.start() is called).
   *
   * Use {@link createMSTeamsExpressAdapter} to construct a properly-typed
   * adapter from an Express application.
   */
  httpServerAdapter?: MSTeamsHttpServerAdapter;
  /**
   * Custom messaging endpoint path.
   * @default '/api/messages'
   */
  messagingEndpoint?: `/${string}`;
  /**
   * OAuth connection name used by the SDK's built-in sign-in handlers.
   * @default 'graph'
   */
  oauthDefaultConnectionName?: string;
  /** Teams SDK cloud environment. Defaults to Public. */
  cloud?: MSTeamsCloudName;
  /** Bot Connector service URL for SDK app-level proactive operations. */
  serviceUrl?: string;
  /** Injectable SDK HTTP client. Used by focused tests; production uses SDK defaults. */
  httpClient?: unknown;
};

/**
 * Create a Teams SDK App instance from credentials. The App manages token
 * acquisition, JWT validation, and the HTTP server lifecycle.
 *
 * Auth modes:
 * - Secret: clientId + clientSecret → MSAL client credential flow (SDK built-in)
 * - Managed identity: clientId + managedIdentityClientId → SDK built-in MI support
 * - Certificate: clientId + custom token provider via @azure/identity
 */
async function createMSTeamsApp(
  creds: MSTeamsCredentials,
  options?: CreateMSTeamsAppOptions,
): Promise<MSTeamsApp> {
  const { App, cloudFromName } = await loadSdkModules();
  const privateQaRuntime = resolveMSTeamsPrivateQaRuntime();
  // Tag outbound SDK HTTP calls with a User-Agent fragment so the Teams
  // backend can identify OpenClaw traffic for usage telemetry. Teams SDK
  // 2.0.11+ preserves both its own `teams.ts[apps]/<sdk-version>` identifier
  // and caller-provided User-Agent fragments when plain client headers are used.
  const cloud = options?.cloud ?? "Public";
  const serviceUrl = options?.serviceUrl
    ? normalizeBotFrameworkServiceUrl(options.serviceUrl)
    : undefined;
  const appOptions: Record<string, unknown> = {
    client: privateQaRuntime?.client ??
      options?.httpClient ?? {
        headers: { "User-Agent": buildOpenClawUserAgentFragment() },
        timeout: MSTEAMS_REQUEST_TIMEOUT_MS,
        interceptors: [msteamsConnectorHandoffInterceptor],
      },
    ...(privateQaRuntime
      ? {
          // Teams SDK prefers clientSecret over token and falls back to CLIENT_SECRET.
          // Clear it explicitly so private QA cannot escape to real Azure auth.
          clientSecret: "",
          skipAuth: privateQaRuntime.skipAuth,
          token: privateQaRuntime.token,
        }
      : {}),
    ...(options?.httpServerAdapter ? { httpServerAdapter: options.httpServerAdapter } : {}),
    ...(options?.messagingEndpoint ? { messagingEndpoint: options.messagingEndpoint } : {}),
    cloud: cloudFromName(cloud),
    ...(serviceUrl ? { serviceUrl } : {}),
    ...(options?.oauthDefaultConnectionName
      ? { oauth: { defaultConnectionName: options.oauthDefaultConnectionName } }
      : {}),
  };

  if (creds.type === "federated") {
    // Teams SDK otherwise lets ambient CLIENT_SECRET override both federated modes.
    return await createFederatedApp(creds, App, { clientSecret: "", ...appOptions });
  }
  return new App({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
    ...appOptions,
  } as ConstructorParameters<typeof App>[0]) as unknown as MSTeamsApp;
}

async function createFederatedApp(
  creds: MSTeamsFederatedCredentials,
  App: typeof import("@microsoft/teams.apps").App,
  appOptions: Record<string, unknown>,
): Promise<MSTeamsApp> {
  if (creds.useManagedIdentity) {
    // The SDK handles managed identity natively — pass managedIdentityClientId
    // and it selects the right credential flow (system MI, user MI, or FIC).
    return new App({
      clientId: creds.appId,
      tenantId: creds.tenantId,
      managedIdentityClientId: creds.managedIdentityClientId ?? "system",
      ...appOptions,
    } as unknown as ConstructorParameters<typeof App>[0]) as unknown as MSTeamsApp;
  }

  // Certificate-based auth — the SDK doesn't have built-in cert support,
  // so we use AppOptions.token with @azure/identity's ClientCertificateCredential.
  if (!creds.certificatePath) {
    throw new Error("Federated credentials require either a certificate path or managed identity.");
  }

  let privateKey: string;
  try {
    privateKey = await readSecretFile(creds.certificatePath, "Microsoft Teams certificate");
  } catch {
    throw new Error("Failed to read certificate file: the configured credential is unavailable.");
  }

  return createCertificateApp(creds, privateKey, App, appOptions);
}

function createCertificateApp(
  creds: MSTeamsFederatedCredentials,
  privateKey: string,
  App: typeof import("@microsoft/teams.apps").App,
  appOptions: Record<string, unknown>,
): MSTeamsApp {
  let credentialPromise: Promise<AzureTokenCredential> | null = null;

  const getCredential = async () => {
    if (!credentialPromise) {
      credentialPromise = loadAzureIdentity().then(
        (az) =>
          new az.ClientCertificateCredential(creds.tenantId, creds.appId, {
            certificate: privateKey,
          }),
      );
    }
    return credentialPromise;
  };

  const tokenProvider = async (scope: string | string[]): Promise<string> => {
    const credential = await getCredential();
    const token = await credential.getToken(scope);

    if (!token?.token) {
      throw new Error("Failed to acquire token via certificate credential.");
    }

    return token.token;
  };

  return new App({
    clientId: creds.appId,
    tenantId: creds.tenantId,
    token: tokenProvider,
    ...appOptions,
  } as unknown as ConstructorParameters<typeof App>[0]) as unknown as MSTeamsApp;
}

/**
 * Build a token provider that uses the Teams SDK App's public token provider
 * for token acquisition.
 */
export function createMSTeamsTokenProvider(
  app: Pick<MSTeamsApp, "tokenProvider" | "credentials" | "cloud">,
): MSTeamsTokenProvider {
  return {
    async getAccessToken(scope: string): Promise<string> {
      if (
        scope.includes("graph.microsoft.com") ||
        scope.includes("graph.microsoft.us") ||
        scope.includes("microsoftgraph.chinacloudapi.cn")
      ) {
        if (app.cloud?.graphScope?.includes("microsoftgraph.chinacloudapi.cn")) {
          throw new Error(
            "Microsoft Teams Graph operations are not supported for channels.msteams.cloud=China until Graph requests are routed through the Azure China Graph endpoint.",
          );
        }
        const token = await app.tokenProvider.getAppToken(
          app.cloud?.graphScope ?? "https://graph.microsoft.com/.default",
          app.credentials?.tenantId || "common",
        );
        return token?.toString() ?? "";
      }
      const token = await app.tokenProvider.getAppToken(
        app.cloud?.botScope ?? "https://api.botframework.com/.default",
      );
      return token?.toString() ?? "";
    },
  };
}

export async function loadMSTeamsSdkWithAuth(
  creds: MSTeamsCredentials,
  options?: CreateMSTeamsAppOptions,
) {
  const app = await createMSTeamsApp(creds, options);
  return { app };
}

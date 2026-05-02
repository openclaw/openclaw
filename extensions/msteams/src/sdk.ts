import * as fs from "node:fs";
import type { MSTeamsCredentials, MSTeamsFederatedCredentials } from "./token.js";

/**
 * Resolved Teams SDK modules loaded lazily to avoid importing when the
 * provider is disabled.
 */
type TeamsSdkModules = {
  App: typeof import("@microsoft/teams.apps").App;
};

/**
 * Structural interface for the Teams SDK App — avoids tsgo resolution bugs
 * with @microsoft/teams.api hashed declaration files.
 */
export type MSTeamsApp = {
  send(conversationId: string, activity: unknown): Promise<{ id?: string }>;
  on(event: string, cb: (...args: unknown[]) => unknown): unknown;
  initialize(): Promise<void>;
  tokenManager: {
    getGraphToken(): Promise<unknown>;
    getBotToken(): Promise<unknown>;
  };
  api: {
    conversations: {
      activities(conversationId: string): {
        update(activityId: string, activity: unknown): Promise<unknown>;
        delete(activityId: string): Promise<unknown>;
      };
    };
  };
};

/**
 * Token provider compatible with the existing codebase, wrapping the Teams
 * SDK App's public tokenManager.
 */
export type MSTeamsTokenProvider = {
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

let azureIdentityModulePromise: Promise<AzureIdentityModule> | null = null;

async function loadAzureIdentity(): Promise<AzureIdentityModule> {
  azureIdentityModulePromise ??= import(AZURE_IDENTITY_MODULE) as Promise<AzureIdentityModule>;
  return azureIdentityModulePromise;
}

let sdkAppPromise: Promise<TeamsSdkModules> | null = null;

async function loadSdkModules(): Promise<TeamsSdkModules> {
  sdkAppPromise ??= import("@microsoft/teams.apps").then((m) => ({ App: m.App }));
  return sdkAppPromise;
}

/**
 * Options for creating a Teams SDK App instance.
 */
export type CreateMSTeamsAppOptions = {
  /**
   * HTTP server adapter to use. When an Express app is available (monitor
   * mode), pass an ExpressAdapter so the SDK registers routes and handles
   * JWT validation. When omitted, the SDK creates a default ExpressAdapter
   * (no server starts until app.start() is called).
   */
  /** Structural type for an HTTP server adapter (e.g. ExpressAdapter). */
  httpServerAdapter?: {
    registerRoute(method: string, path: string, handler: unknown): void;
    start?(port: number | string): Promise<void>;
    stop?(): Promise<void>;
  };
  /**
   * Custom messaging endpoint path.
   * @default '/api/messages'
   */
  messagingEndpoint?: `/${string}`;
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
export async function createMSTeamsApp(
  creds: MSTeamsCredentials,
  options?: CreateMSTeamsAppOptions,
): Promise<MSTeamsApp> {
  const { App } = await loadSdkModules();
  const appOptions: Record<string, unknown> = {
    ...(options?.httpServerAdapter ? { httpServerAdapter: options.httpServerAdapter } : {}),
    ...(options?.messagingEndpoint ? { messagingEndpoint: options.messagingEndpoint } : {}),
  };

  if (creds.type === "federated") {
    return createFederatedApp(creds, App, appOptions);
  }
  return new App({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
    ...appOptions,
  } as ConstructorParameters<typeof App>[0]) as unknown as MSTeamsApp;
}

function createFederatedApp(
  creds: MSTeamsFederatedCredentials,
  App: TeamsSdkModules["App"],
  appOptions: Record<string, unknown>,
): MSTeamsApp {
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
    privateKey = fs.readFileSync(creds.certificatePath, "utf-8");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to read certificate file at '${creds.certificatePath}': ${msg}`, {
      cause: err,
    });
  }

  return createCertificateApp(creds, privateKey, App, appOptions);
}

function createCertificateApp(
  creds: MSTeamsFederatedCredentials,
  privateKey: string,
  App: TeamsSdkModules["App"],
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
 * Build a token provider that uses the Teams SDK App's public tokenManager
 * for token acquisition.
 */
export function createMSTeamsTokenProvider(app: MSTeamsApp): MSTeamsTokenProvider {
  const tokenToString = (token: unknown): string => {
    if (token == null) {
      return "";
    }
    return (token as { toString(): string }).toString();
  };
  return {
    async getAccessToken(scope: string): Promise<string> {
      if (scope.includes("graph.microsoft.com")) {
        return tokenToString(await app.tokenManager.getGraphToken());
      }
      return tokenToString(await app.tokenManager.getBotToken());
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

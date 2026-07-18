// Microsoft Graph auth: access-token acquisition for the mail-wake plugin.
// @azure/identity is lazy-loaded so the dependency never enters lightweight
// plugin loads, and secret resolution goes through the configured secret-input
// machinery (env/file/exec refs).
//
// Token strings are never cached across calls: bearer tokens expire, and
// @azure/identity already caches/renews client-credential tokens internally.
import {
  createLazyRuntimeModule,
  resolveConfiguredSecretInputString,
  type OpenClawConfig,
} from "../runtime-api.js";
import type { GraphWakeAuthConfig } from "./config.js";

const GRAPH_TOKEN_SCOPE = "https://graph.microsoft.com/.default";
const AZURE_IDENTITY_MODULE = "@azure/identity";

type AzureAccessToken = {
  token?: string;
} | null;

type AzureTokenCredential = {
  getToken: (scope: string | string[]) => Promise<AzureAccessToken>;
};

type AzureIdentityModule = {
  ClientSecretCredential: new (
    tenantId: string,
    clientId: string,
    clientSecret: string,
  ) => AzureTokenCredential;
};

const loadAzureIdentity = createLazyRuntimeModule(
  () => import(AZURE_IDENTITY_MODULE) as Promise<AzureIdentityModule>,
);

export type GraphTokenProvider = {
  getAccessToken: () => Promise<string>;
};

export function createGraphTokenProvider(params: {
  auth: GraphWakeAuthConfig;
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  authConfigPath: string;
}): GraphTokenProvider {
  const env = params.env ?? process.env;
  const resolveSecret = async (value: unknown, key: string): Promise<string> => {
    const resolved = await resolveConfiguredSecretInputString({
      config: params.config,
      env,
      value,
      path: `${params.authConfigPath}.${key}`,
      unresolvedReasonStyle: "generic",
    });
    if (!resolved.value) {
      throw new Error(`Microsoft Graph ${key} is not configured.`);
    }
    return resolved.value;
  };

  if ("bearerToken" in params.auth && params.auth.bearerToken !== undefined) {
    const bearerToken = params.auth.bearerToken;
    return {
      getAccessToken: () => resolveSecret(bearerToken, "bearerToken"),
    };
  }

  // Schema guarantees the client-credentials shape when bearerToken is absent.
  const clientCredentials = params.auth as {
    tenantId: string;
    clientId: string;
    clientSecret: unknown;
  };
  let credentialPromise: Promise<AzureTokenCredential> | null = null;
  const getCredential = (): Promise<AzureTokenCredential> => {
    credentialPromise ??= resolveSecret(clientCredentials.clientSecret, "clientSecret").then(
      async (secret) => {
        const azure = await loadAzureIdentity();
        return new azure.ClientSecretCredential(
          clientCredentials.tenantId,
          clientCredentials.clientId,
          secret,
        );
      },
    );
    return credentialPromise;
  };
  return {
    getAccessToken: async () => {
      const credential = await getCredential();
      const token = await credential.getToken(GRAPH_TOKEN_SCOPE);
      if (!token?.token) {
        throw new Error("Failed to acquire Microsoft Graph access token.");
      }
      return token.token;
    },
  };
}

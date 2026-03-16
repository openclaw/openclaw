import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsCredentials } from "./token.js";

export type MSTeamsSdk = typeof import("@microsoft/agents-hosting");
export type MSTeamsAuthConfig = ReturnType<MSTeamsSdk["getAuthConfigWithDefaults"]>;

/**
 * Token provider that wraps @azure/identity's DefaultAzureCredential.
 * Implements the same getAccessToken(scope) interface as MsalTokenProvider
 * so it can be used as a drop-in replacement throughout the plugin.
 *
 * Accepts appId (clientId) and tenantId so the credential targets the
 * correct bot identity — required for workload identity and user-assigned
 * managed identity where multiple identities may be available.
 */
export class DefaultAzureCredentialTokenProvider {
  private credential: import("@azure/identity").DefaultAzureCredential | undefined;
  private readonly clientId: string;
  private readonly tenantId: string;

  constructor(clientId: string, tenantId: string) {
    this.clientId = clientId;
    this.tenantId = tenantId;
  }

  /**
   * Acquire a token for the given resource. Callers pass resource URIs
   * (e.g. "https://graph.microsoft.com"), which are normalized to AAD
   * scopes ("https://graph.microsoft.com/.default") as required by
   * @azure/identity's getToken().
   */
  async getAccessToken(resource: string) {
    if (!this.credential) {
      const { DefaultAzureCredential } = await import("@azure/identity");
      this.credential = new DefaultAzureCredential({
        managedIdentityClientId: this.clientId,
        workloadIdentityClientId: this.clientId,
        tenantId: this.tenantId,
      });
    }
    // Normalize resource URI to AAD scope — MsalTokenProvider accepts bare
    // resource URIs but DefaultAzureCredential.getToken() requires scopes.
    const scope = resource.endsWith("/.default")
      ? resource
      : `${resource.replace(/\/+$/, "")}/.default`;
    const token = await this.credential.getToken(scope);
    if (!token)
      throw new Error(`DefaultAzureCredential: failed to acquire token for scope ${scope}`);
    return token.token;
  }
}

export async function loadMSTeamsSdk(): Promise<MSTeamsSdk> {
  return await import("@microsoft/agents-hosting");
}

export function buildMSTeamsAuthConfig(
  creds: MSTeamsCredentials,
  sdk: MSTeamsSdk,
): MSTeamsAuthConfig {
  const base: Parameters<MSTeamsSdk["getAuthConfigWithDefaults"]>[0] = {
    clientId: creds.appId,
    tenantId: creds.tenantId,
  };

  switch (creds.authType) {
    case "certificate":
      if (creds.certPemFile) base.certPemFile = creds.certPemFile;
      if (creds.certKeyFile) base.certKeyFile = creds.certKeyFile;
      if (creds.sendX5C != null) base.sendX5C = creds.sendX5C;
      break;
    case "federatedCredential":
      if (creds.ficClientId) base.FICClientId = creds.ficClientId;
      if (creds.widAssertionFile) base.WIDAssertionFile = creds.widAssertionFile;
      break;
    case "defaultAzureCredential":
      // No additional fields needed — DAC handles credential discovery.
      // The SDK still needs clientId/tenantId for audience validation.
      break;
    case "clientSecret":
    default:
      if (creds.appPassword) base.clientSecret = creds.appPassword;
      break;
  }

  return sdk.getAuthConfigWithDefaults(base);
}

/**
 * Create the appropriate token provider based on auth type.
 * For defaultAzureCredential, returns our DAC wrapper instead of MsalTokenProvider.
 */
export function createTokenProvider(
  creds: MSTeamsCredentials,
  authConfig: MSTeamsAuthConfig,
  sdk: MSTeamsSdk,
) {
  if (creds.authType === "defaultAzureCredential") {
    return new DefaultAzureCredentialTokenProvider(creds.appId, creds.tenantId);
  }
  return new sdk.MsalTokenProvider(authConfig);
}

export function createMSTeamsAdapter(
  authConfig: MSTeamsAuthConfig,
  sdk: MSTeamsSdk,
): MSTeamsAdapter {
  return new sdk.CloudAdapter(authConfig) as unknown as MSTeamsAdapter;
}

export async function loadMSTeamsSdkWithAuth(creds: MSTeamsCredentials) {
  const sdk = await loadMSTeamsSdk();
  const authConfig = buildMSTeamsAuthConfig(creds, sdk);
  return { sdk, authConfig, creds };
}

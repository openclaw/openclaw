import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsCredentials } from "./token.js";

export type MSTeamsSdk = typeof import("@microsoft/agents-hosting");
export type MSTeamsAuthConfig = ReturnType<MSTeamsSdk["getAuthConfigWithDefaults"]>;

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
      base.certPemFile = creds.certPemFile;
      base.certKeyFile = creds.certKeyFile;
      if (creds.sendX5C != null) base.sendX5C = creds.sendX5C;
      break;
    case "federatedCredential":
      if (creds.ficClientId) base.FICClientId = creds.ficClientId;
      if (creds.widAssertionFile) base.WIDAssertionFile = creds.widAssertionFile;
      break;
    case "clientSecret":
    default:
      if (creds.appPassword) base.clientSecret = creds.appPassword;
      break;
  }

  return sdk.getAuthConfigWithDefaults(base);
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
  return { sdk, authConfig };
}

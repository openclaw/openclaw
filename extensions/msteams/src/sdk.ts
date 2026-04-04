import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsCredentials, MSTeamsFederatedCredentials } from "./token.js";

export type MSTeamsSdk = typeof import("@microsoft/agents-hosting");
export type MSTeamsAuthConfig = ReturnType<MSTeamsSdk["getAuthConfigWithDefaults"]>;

export async function loadMSTeamsSdk(): Promise<MSTeamsSdk> {
  return await import("@microsoft/agents-hosting");
}

export function buildMSTeamsAuthConfig(
  creds: MSTeamsCredentials,
  sdk: MSTeamsSdk,
): MSTeamsAuthConfig {
  if (creds.type === "federated") {
    return buildFederatedAuthConfig(creds, sdk);
  }

  return sdk.getAuthConfigWithDefaults({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  });
}

function buildFederatedAuthConfig(
  creds: MSTeamsFederatedCredentials,
  sdk: MSTeamsSdk,
): MSTeamsAuthConfig {
  if (creds.useManagedIdentity) {
    // Workload Identity (AKS): the projected service-account token is at the
    // path in AZURE_FEDERATED_TOKEN_FILE.  The @microsoft/agents-hosting SDK
    // accepts this via its WIDAssertionFile config key, which MSAL Node then
    // uses for the client-credentials assertion grant against Entra ID.
    const assertionFile =
      process.env.AZURE_FEDERATED_TOKEN_FILE || process.env.WIDAssertionFile;
    return sdk.getAuthConfigWithDefaults({
      clientId: creds.managedIdentityClientId || creds.appId,
      tenantId: creds.tenantId,
      ...(assertionFile ? { WIDAssertionFile: assertionFile } : {}),
    });
  }

  if (!creds.certificatePath) {
    throw new Error("Federated credentials require either a certificate path or managed identity.");
  }

  // Certificate-based auth using the SDK's native certPemFile support.
  return sdk.getAuthConfigWithDefaults({
    clientId: creds.appId,
    tenantId: creds.tenantId,
    certPemFile: creds.certificatePath,
    sendX5C: true,
  });
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

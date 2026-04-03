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
    // Managed identity: no secret, no certificate — the SDK/runtime handles
    // token acquisition via the IMDS endpoint.
    return sdk.getAuthConfigWithDefaults({
      clientId: creds.managedIdentityClientId || creds.appId,
      tenantId: creds.tenantId,
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

import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsCredentials } from "./token.js";
import { buildUserAgent } from "./user-agent.js";

export type MSTeamsSdk = typeof import("@microsoft/agents-hosting");
export type MSTeamsAuthConfig = ReturnType<MSTeamsSdk["getAuthConfigWithDefaults"]>;

export async function loadMSTeamsSdk(): Promise<MSTeamsSdk> {
  return await import("@microsoft/agents-hosting");
}

export function buildMSTeamsAuthConfig(
  creds: MSTeamsCredentials,
  sdk: MSTeamsSdk,
): MSTeamsAuthConfig {
  return sdk.getAuthConfigWithDefaults({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  });
}

/**
 * Create a CloudAdapter subclass that injects the OpenClaw User-Agent
 * into every outbound ConnectorClient (both inbound webhook replies
 * and proactive messages via continueConversation).
 */
export function createMSTeamsAdapter(
  authConfig: MSTeamsAuthConfig,
  sdk: MSTeamsSdk,
): MSTeamsAdapter {
  const { CloudAdapter, HeaderPropagation } = sdk;

  class OpenClawCloudAdapter extends CloudAdapter {
    protected override async createConnectorClient(
      ...args: Parameters<InstanceType<typeof CloudAdapter>["createConnectorClient"]>
    ) {
      const [serviceUrl, scope, identity, headers] = args;
      const propagation = headers ?? new HeaderPropagation({});
      if (!propagation.get("User-Agent")) {
        propagation.override({ "User-Agent": buildUserAgent() });
      }
      return super.createConnectorClient(serviceUrl, scope, identity, propagation);
    }

    protected override async createConnectorClientWithIdentity(
      ...args: Parameters<InstanceType<typeof CloudAdapter>["createConnectorClientWithIdentity"]>
    ) {
      const [identity, activity, headers] = args;
      const propagation = headers ?? new HeaderPropagation({});
      if (!propagation.get("User-Agent")) {
        propagation.override({ "User-Agent": buildUserAgent() });
      }
      return super.createConnectorClientWithIdentity(identity, activity, propagation);
    }
  }

  return new OpenClawCloudAdapter(authConfig) as unknown as MSTeamsAdapter;
}

export async function loadMSTeamsSdkWithAuth(creds: MSTeamsCredentials) {
  const sdk = await loadMSTeamsSdk();
  const authConfig = buildMSTeamsAuthConfig(creds, sdk);
  return { sdk, authConfig };
}

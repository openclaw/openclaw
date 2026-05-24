import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import type { ResolvedChannelBrokerAccount } from "./types.js";

export const channelBrokerStatus = createComputedAccountStatusAdapter<ResolvedChannelBrokerAccount>(
  {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        if (account.configured) {
          return [];
        }
        return [
          {
            channel: "channel-broker",
            accountId: account.accountId,
            kind: "config",
            message: "Provider not configured (missing baseUrl)",
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
    }),
    probeAccount: async ({ account }) => ({
      ok: account.configured,
      providerId: account.providerId,
      platforms: account.platforms,
    }),
    resolveAccountSnapshot: ({ account }) => ({
      accountId: account.providerId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl ?? undefined,
      allowFrom: account.allowFrom.map(String),
      extra: {
        platforms: account.platforms,
        defaultPlatform: account.defaultPlatform,
        defaultConversationType: account.defaultConversationType,
        capabilities: account.capabilities,
      },
    }),
  },
);

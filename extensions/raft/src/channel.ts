// Raft channel plugin wires the wake bridge into the canonical channel runtime.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { detectBinary } from "openclaw/plugin-sdk/setup-tools";
import {
  buildBaseChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { RAFT_CHANNEL_ID, type ResolvedRaftAccount } from "./accounts.js";
import { raftChannelConfigSchema } from "./config-schema.js";
import { startRaftGatewayAccount } from "./gateway.js";
import { raftSetupPlugin } from "./setup.js";

type RaftProbe =
  | { ok: true; cliFound: true; error: null }
  | { ok: false; cliFound: false; error: string };

export const raftPlugin: ChannelPlugin<ResolvedRaftAccount, RaftProbe> = createChatChannelPlugin({
  base: {
    ...raftSetupPlugin,
    reload: { configPrefixes: ["channels.raft"] },
    configSchema: raftChannelConfigSchema,
    config: {
      ...raftSetupPlugin.config,
      describeAccount: (account) =>
        describeAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            profile: account.profile,
          },
        }),
    },
    status: createComputedAccountStatusAdapter<ResolvedRaftAccount, RaftProbe>({
      defaultRuntime: createDefaultChannelRuntimeState("default"),
      buildChannelSummary: ({ snapshot }) => buildBaseChannelStatusSummary(snapshot),
      probeAccount: async () => {
        const cliFound = await detectBinary("raft");
        return cliFound
          ? { ok: true, cliFound: true, error: null }
          : {
              ok: false,
              cliFound: false,
              error: "Raft CLI not found on the Gateway PATH",
            };
      },
      formatCapabilitiesProbe: ({ probe }) => [
        {
          text: `Raft CLI: ${probe.cliFound ? "found" : "missing"}`,
          ...(probe.cliFound ? {} : { tone: "error" as const }),
        },
      ],
      collectStatusIssues: (accounts) =>
        accounts.flatMap((account) => {
          if (!account.configured) {
            return [
              {
                channel: RAFT_CHANNEL_ID,
                accountId: account.accountId,
                kind: "config",
                message: "Raft account is missing a CLI profile",
                fix: "Set channels.raft.profile or RAFT_PROFILE.",
              },
            ];
          }
          return [];
        }),
      resolveAccountSnapshot: ({ account }) => ({
        accountId: account.accountId,
        name: account.name ?? undefined,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          profile: account.profile,
        },
      }),
    }),
    gateway: {
      startAccount: startRaftGatewayAccount,
    },
  },
});

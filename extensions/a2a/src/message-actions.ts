import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionDiscoveryContext,
} from "openclaw/plugin-sdk/channel-contract";
import { DEFAULT_ACCOUNT_ID, resolveA2aChannelAccount } from "./accounts.js";

export function describeMessageTool({ cfg, accountId }: ChannelMessageActionDiscoveryContext) {
  const account = resolveA2aChannelAccount({ cfg, accountId });
  return {
    actions:
      account.accountId === DEFAULT_ACCOUNT_ID &&
      account.enabled &&
      Object.values(account.config.peers ?? {}).some((peer) => peer.url)
        ? (["send", "read"] as const)
        : [],
  };
}

export const a2aMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool,
  providerOwnedReadGates: ["read"],
  readAuthorityActions: ["read"],
  writeAuthorityActions: ["send"],
  // Receipts and reads must share the Gateway owner, including worker tools.
  resolveExecutionMode: () => "gateway",
  supportsAction: ({ action }) => action === "send" || action === "read",
  handleAction: async (ctx) => {
    const { handleA2aTaskAction } = await import("./task-actions.js");
    return await handleA2aTaskAction(ctx);
  },
};

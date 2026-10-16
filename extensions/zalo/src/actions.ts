import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { inspectZaloAccount, listZaloAccountIds } from "./accounts.js";

const ZALO_ACTIONS = new Set<ChannelMessageActionName>(["send"]);

function listEnabledAccounts(cfg: OpenClawConfig, accountId?: string | null) {
  return (
    accountId
      ? [inspectZaloAccount({ cfg, accountId })]
      : listZaloAccountIds(cfg).map((listedAccountId) =>
          inspectZaloAccount({ cfg, accountId: listedAccountId }),
        )
  ).filter((account) => account.enabled && account.tokenStatus === "available");
}

export const zaloMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    const accounts = listEnabledAccounts(cfg, accountId);
    if (accounts.length === 0) {
      return null;
    }
    return { actions: Array.from(ZALO_ACTIONS), capabilities: [] };
  },
  // No plugin-owned actions: unsupported ones fail fast, and core delivers `send`
  // through the outbound adapter, which chunks at Zalo's 2000-character limit. A
  // plugin-owned send handler skipped that: Zalo kept the first 2000 characters and
  // the tool still reported success.
  supportsAction: () => false,
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  prepareSendPayload: ({ ctx, payload }) => (ctx.action === "send" ? payload : null),
};

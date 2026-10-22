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
  supportsAction: ({ action }) => ZALO_ACTIONS.has(action),
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
};

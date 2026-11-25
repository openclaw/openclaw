// Google Chat message-tool discovery stays read-only and account-isolated.
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import { inspectGoogleChatAccount, listGoogleChatAccountIds } from "./accounts.js";

export const googlechatMessageActions = {
  describeMessageTool({ cfg, accountId }) {
    const accounts = accountId
      ? [inspectGoogleChatAccount({ cfg, accountId })]
      : listGoogleChatAccountIds(cfg).map((listedAccountId) =>
          inspectGoogleChatAccount({ cfg, accountId: listedAccountId }),
        );
    const hasAvailableAccount = accounts.some(
      (account) =>
        account.enabled &&
        account.credentialSource !== "none" &&
        account.tokenStatus === "available",
    );
    return hasAvailableAccount ? { actions: ["send" as const] } : null;
  },
  supportsAction: ({ action }) => action === "send",
  extractToolSend: ({ args }) => extractToolSend(args, "sendMessage"),
  handleAction: async (ctx) => (await import("./actions.js")).handleGoogleChatAction(ctx),
} satisfies ChannelMessageActionAdapter;

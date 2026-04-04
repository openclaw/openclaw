import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveTelegramAccount } from "./accounts.js";
import { resolveTelegramAutoThreadId } from "./action-threading.js";
import { buildTelegramThreadingToolContext } from "./threading-tool-context.js";

export function resolveTelegramReplyToMode(params: { cfg: OpenClawConfig; accountId: string }) {
  return resolveTelegramAccount({ cfg: params.cfg, accountId: params.accountId }).config
    .replyToMode;
}

export const telegramThreading = {
  scopedAccountReplyToMode: {
    resolveAccount: (cfg: OpenClawConfig, accountId: string) =>
      resolveTelegramAccount({ cfg, accountId }),
    resolveReplyToMode: (account: ReturnType<typeof resolveTelegramAccount>) =>
      account.config.replyToMode,
    fallback: "off" as const,
  },
  buildToolContext: (params: Parameters<typeof buildTelegramThreadingToolContext>[0]) =>
    buildTelegramThreadingToolContext(params),
  resolveAutoThreadId: ({
    to,
    toolContext,
  }: {
    to: string;
    toolContext?: { currentThreadTs?: string; currentChannelId?: string };
  }) => resolveTelegramAutoThreadId({ to, toolContext }),
};

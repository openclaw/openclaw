import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { resolveFeishuGroupConfig } from "./policy.js";
import { getFeishuRuntime } from "./runtime.js";
import { getMessageFeishu } from "./send.js";
import {
  isFeishuGroupChatType,
  type FeishuMessageContext,
  type FeishuMessageInfo,
  type ResolvedFeishuAccount,
} from "./types.js";

export async function prepareFeishuThreadRoot(params: {
  cfg: ClawdbotConfig;
  account: ResolvedFeishuAccount;
  ctx: FeishuMessageContext;
  botOpenId?: string;
  log: (message: string) => void;
}) {
  let { cfg, account } = params;
  const { ctx, botOpenId, log } = params;
  const localBotOpenId = botOpenId?.trim();
  let rootMessagePromise: Promise<FeishuMessageInfo | null> | undefined;
  const getRootMessageInfo = (): Promise<FeishuMessageInfo | null> => {
    if (!ctx.rootId) {
      return Promise.resolve(null);
    }
    rootMessagePromise ??= getMessageFeishu({
      cfg,
      messageId: ctx.rootId,
      accountId: account.accountId,
    }).catch((err: unknown) => {
      log(`feishu[${account.accountId}]: failed to fetch root message: ${String(err)}`);
      return null;
    });
    return rootMessagePromise;
  };
  let isBotOwnedThread = false;
  const configuredBotThreadMention =
    resolveFeishuGroupConfig({ cfg: account.config, groupId: ctx.chatId })
      ?.requireMentionInBotThreads ?? account.config.requireMentionInBotThreads;
  // root_id alone also occurs on inline quotes; thread metadata identifies a topic reply.
  if (
    isFeishuGroupChatType(ctx.chatType) &&
    configuredBotThreadMention !== undefined &&
    ctx.rootId &&
    (ctx.threadId?.trim() || ctx.chatType === "topic_group")
  ) {
    const rootMessage = await getRootMessageInfo();
    // SAFETY: The account resolver reads the host-validated snapshot without mutating it.
    const currentCfg = getFeishuRuntime().config.current() as ClawdbotConfig;
    const currentAccount = resolveFeishuRuntimeAccount({
      cfg: currentCfg,
      accountId: account.accountId,
    });
    if (
      !currentAccount.enabled ||
      currentAccount.appId !== account.appId ||
      currentAccount.domain !== account.domain ||
      (ctx.senderType === "bot" && currentAccount.config.allowBots !== true)
    ) {
      log(`feishu[${account.accountId}]: account changed while resolving thread ownership`);
      return null;
    }
    cfg = currentCfg;
    account = currentAccount;
    isBotOwnedThread = Boolean(
      rootMessage?.messageId === ctx.rootId &&
      rootMessage.chatId === ctx.chatId &&
      rootMessage.senderType === "app" &&
      ((account.appId && rootMessage.senderId === account.appId) ||
        (localBotOpenId && rootMessage.senderOpenId === localBotOpenId)),
    );
  }
  return { cfg, account, isBotOwnedThread, getRootMessageInfo };
}

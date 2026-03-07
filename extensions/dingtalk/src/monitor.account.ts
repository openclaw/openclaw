import type { DWClientDownStream } from "dingtalk-stream";
import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/dingtalk";
import { createDedupeCache } from "openclaw/plugin-sdk/dingtalk";
import { handleDingtalkMessage } from "./bot.js";
import { monitorStream } from "./monitor.transport.js";
import type { ResolvedDingtalkAccount, DingtalkRobotMessage } from "./types.js";

// 消息去重缓存（防止 Stream 重试导致重复处理） / Dedupe cache to prevent duplicate processing from Stream retries
const dedupeCache = createDedupeCache({ maxSize: 500, ttlMs: 60_000 });

/**
 * 启动单账号的消息监控 / Start message monitoring for a single account
 */
export async function monitorSingleAccount(params: {
  cfg: ClawdbotConfig;
  account: ResolvedDingtalkAccount;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const { cfg, account, runtime, abortSignal } = params;
  const log = runtime?.log ?? console.log;

  log(`dingtalk[${account.accountId}]: starting stream monitor`);

  await monitorStream({
    account,
    abortSignal,
    log,
    onMessage: (downstream: DWClientDownStream, ack) => {
      const streamMessageId = downstream.headers?.messageId;

      // Immediately acknowledge the callback to prevent DingTalk from re-delivering (~60s timeout)
      if (streamMessageId) ack(streamMessageId);

      try {
        const msg = JSON.parse(downstream.data) as DingtalkRobotMessage;
        const rawMessageId = msg.msgId ?? streamMessageId;
        const messageId = rawMessageId ? `${account.accountId}:${rawMessageId}` : undefined;

        if (messageId && dedupeCache.check(messageId)) {
          log(`dingtalk[${account.accountId}]: skipping duplicate message ${messageId}`);
          return;
        }

        handleDingtalkMessage({
          cfg,
          account,
          msg,
          runtime,
        }).catch((err) => {
          log(`dingtalk[${account.accountId}]: error handling message: ${err}`);
        });
      } catch (err) {
        log(`dingtalk[${account.accountId}]: error parsing message: ${err}`);
      }
    },
  });
}

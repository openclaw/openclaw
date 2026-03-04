import type { ClawdbotConfig, RuntimeEnv } from "openclaw/plugin-sdk/dingtalk";
import { createDedupeCache } from "openclaw/plugin-sdk/dingtalk";
import type { DWClientDownStream } from "dingtalk-stream";
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
    onMessage: (downstream: DWClientDownStream) => {
      try {
        const msg = JSON.parse(downstream.data) as DingtalkRobotMessage;
        const messageId = msg.msgId ?? downstream.headers?.messageId;

        // 消息去重：check() 返回 true 表示已存在（重复），同时自动标记新 key
        if (messageId && dedupeCache.check(messageId)) {
          log(`dingtalk[${account.accountId}]: skipping duplicate message ${messageId}`);
          return;
        }

        // 异步处理消息 / Process message asynchronously
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

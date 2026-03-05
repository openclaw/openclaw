import { DWClient, TOPIC_ROBOT } from "dingtalk-stream";
import type { DWClientDownStream } from "dingtalk-stream";
import type { ResolvedDingtalkAccount } from "./types.js";

export type DingtalkStreamCallbackHandler = (msg: DWClientDownStream) => void;

/**
 * 创建并启动 Stream 模式监控 / Create and start Stream mode monitor
 *
 * 使用 dingtalk-stream SDK 建立 WebSocket 长连接，
 * 注册 TOPIC_ROBOT 回调接收消息。
 * Uses dingtalk-stream SDK to establish WebSocket long connection,
 * registers TOPIC_ROBOT callback to receive messages.
 */
export async function monitorStream(params: {
  account: ResolvedDingtalkAccount;
  onMessage: DingtalkStreamCallbackHandler;
  abortSignal?: AbortSignal;
  log?: (...args: unknown[]) => void;
}): Promise<void> {
  const { account, onMessage, abortSignal, log = console.log } = params;

  if (!account.clientId || !account.clientSecret) {
    throw new Error(`DingTalk credentials not configured for account "${account.accountId}"`);
  }

  const client = new DWClient({
    clientId: account.clientId,
    clientSecret: account.clientSecret,
  });

  // 注册机器人消息回调 / Register robot message callback
  client.registerCallbackListener(TOPIC_ROBOT, onMessage);

  // 监听中止信号 / Listen for abort signal
  if (abortSignal) {
    const onAbort = () => {
      log(`dingtalk[${account.accountId}]: abort signal received, disconnecting stream`);
      try {
        client.disconnect();
      } catch {
        // 忽略断开连接时的错误 / Ignore disconnect errors
      }
    };

    if (abortSignal.aborted) {
      return;
    }
    abortSignal.addEventListener("abort", onAbort, { once: true });
  }

  log(`dingtalk[${account.accountId}]: connecting to stream...`);

  // SDK 自带 autoReconnect，断开后自动重连 / SDK has built-in autoReconnect
  await client.connect();

  // Keep the monitor alive until the abort signal fires; returning early
  // causes the channel framework to treat the monitor as exited and restart.
  await new Promise<void>((resolve) => {
    if (abortSignal?.aborted) {
      resolve();
      return;
    }
    abortSignal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

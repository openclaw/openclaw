import { WS_HEARTBEAT } from "../../access/ws/types.js";
import type { WsHeartbeatValue } from "../../access/ws/types.js";
import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";
import type { MessageHandlerContext } from "../messaging/context.js";

const HEARTBEAT_TIMEOUT_MS = 800;
const DEFAULT_RUNNING_HEARTBEAT_INTERVAL_MS = 2000;
const MAX_RUNNING_HEARTBEAT_IDLE_MS = 30000;

export interface ReplyHeartbeatMeta {
  ctx: MessageHandlerContext;
  account: ResolvedYuanbaoAccount;
  toAccount: string;
  groupCode?: string;
}

/**
 * 发送回复状态心跳（best effort，不抛错，不中断主流程）。
 */
export async function emitReplyHeartbeat(
  params: ReplyHeartbeatMeta & {
    heartbeat: WsHeartbeatValue;
    sendTime: number;
  },
): Promise<void> {
  const { ctx, account, toAccount, groupCode, heartbeat, sendTime } = params;
  const log = createLog("reply-heartbeat");
  const fromAccount = account.botId?.trim() ?? "";
  const targetAccount = toAccount.trim();
  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`heartbeat timeout(${timeoutMs}ms)`)),
        timeoutMs,
      );
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

  if (!ctx.wsClient) {
    log.warn(`[${account.accountId}] heartbeat send failed: wsClient unavailable`);
    return;
  }

  if (!fromAccount || !targetAccount) {
    log.warn(`[${account.accountId}] heartbeat send failed: from/to account missing`, {
      fromAccount,
      toAccount: targetAccount,
      groupCode,
      heartbeat,
    });
    return;
  }

  try {
    if (groupCode) {
      const rsp = await withTimeout(
        ctx.wsClient.sendGroupHeartbeat({
          from_account: fromAccount,
          to_account: targetAccount,
          group_code: groupCode,
          send_time: sendTime,
          heartbeat,
        }),
        HEARTBEAT_TIMEOUT_MS,
      );
      if (rsp.code !== 0) {
        log.warn(
          `[${account.accountId}] group reply heartbeat send failed: code=${rsp.code}, msg=${rsp.msg ?? rsp.message ?? ""}`,
        );
      }
      return;
    }

    const rsp = await withTimeout(
      ctx.wsClient.sendPrivateHeartbeat({
        from_account: fromAccount,
        to_account: targetAccount,
        heartbeat,
      }),
      HEARTBEAT_TIMEOUT_MS,
    );
    if (rsp.code !== 0) {
      log.warn(
        `[${account.accountId}] C2C reply heartbeat send failed: code=${rsp.code}, msg=${rsp.msg ?? rsp.message ?? ""}`,
      );
    }
  } catch (err) {
    log.warn(`[${account.accountId}] reply heartbeat send error: ${String(err)}`);
  }
}

export interface ReplyHeartbeatController {
  emit(heartbeat: WsHeartbeatValue): void;
  onReplySent(): void;
  stop(): void;
}

export function createReplyHeartbeatController(params: {
  meta: ReplyHeartbeatMeta;
  runningIntervalMs?: number;
}): ReplyHeartbeatController {
  const { meta } = params;
  const runningIntervalMs = params.runningIntervalMs ?? DEFAULT_RUNNING_HEARTBEAT_INTERVAL_MS;
  let runningHeartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let runningHeartbeatActive = false;
  let runningHeartbeatStartTime: number | null = null;
  let lastRunningEmitAt: number | null = null;

  const send = (heartbeat: WsHeartbeatValue, sendTime: number): void => {
    void emitReplyHeartbeat({
      ...meta,
      heartbeat,
      sendTime,
    });
  };

  const sendRunningHeartbeatAndSchedule = async (): Promise<void> => {
    if (!runningHeartbeatActive) {
      return;
    }
    if (runningHeartbeatStartTime === null) {
      return;
    }
    if (lastRunningEmitAt === null) {
      return;
    }
    if (Date.now() - lastRunningEmitAt > MAX_RUNNING_HEARTBEAT_IDLE_MS) {
      stop();
      return;
    }
    await emitReplyHeartbeat({
      ...meta,
      heartbeat: WS_HEARTBEAT.RUNNING,
      sendTime: runningHeartbeatStartTime,
    });
    if (!runningHeartbeatActive) {
      return;
    }
    runningHeartbeatTimer = setTimeout(() => {
      void sendRunningHeartbeatAndSchedule();
    }, runningIntervalMs);
  };

  const stop = (): void => {
    runningHeartbeatActive = false;
    runningHeartbeatStartTime = null;
    lastRunningEmitAt = null;
    if (runningHeartbeatTimer) {
      clearTimeout(runningHeartbeatTimer);
      runningHeartbeatTimer = null;
    }
  };

  const startRunning = (): void => {
    if (runningHeartbeatActive) {
      return;
    }
    runningHeartbeatActive = true;
    runningHeartbeatStartTime = Date.now();
    lastRunningEmitAt = Date.now();
    void sendRunningHeartbeatAndSchedule();
  };

  const emit = (heartbeat: WsHeartbeatValue): void => {
    if (heartbeat === WS_HEARTBEAT.RUNNING) {
      if (runningHeartbeatActive) {
        lastRunningEmitAt = Date.now();
        return;
      }
      startRunning();
      return;
    }
    stop();
    send(heartbeat, Date.now());
  };

  return {
    emit,
    onReplySent: stop,
    stop,
  };
}

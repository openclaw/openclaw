/**
 * command-lane.ts — ClaWorks 命令 Lane 隔离调度
 *
 * 参照 OpenClaw src/process/command-queue.ts，为 ClaWorks 实现 6 条
 * 独立并发队列，解决所有任务共享单一计数器的根本缺陷：
 *
 *   critical   — 系统告警/错误恢复（concurrency=1，绝不排队等待）
 *   im_user    — IM 消息/Webhook（concurrency=5）
 *   a2a        — A2A 委派任务（concurrency=3）
 *   schedule   — 定时任务/每日维护（concurrency=2）
 *   autonomy   — 自主心跳/学习/进化（concurrency=1）
 *   background — KB 摄入/记忆整合/低优先（concurrency=8）
 *
 * 设计原则（与 OpenClaw 对齐）：
 *   - 每条 Lane 独立 drain 循环，互不阻塞
 *   - 任务带 timeout 防止饿死其他任务
 *   - 任务进入队列时记录 enqueuedAt，超 warnAfterMs 打 warn 日志
 *   - 全局单例（运行时共享，不重建）
 */

export const CwCommandLane = {
  /** 系统告警、错误恢复、关键状态变更 */
  Critical: "critical",
  /** IM 用户消息、Webhook 输入 */
  ImUser: "im_user",
  /** A2A 委派任务 */
  A2a: "a2a",
  /** 定时任务、计划维护 */
  Schedule: "schedule",
  /** 自主心跳、学习、进化 */
  Autonomy: "autonomy",
  /** KB 摄入、记忆整合、后台低优先 */
  Background: "background",
} as const;

export type CwCommandLane = (typeof CwCommandLane)[keyof typeof CwCommandLane];

export type LaneConcurrencyConfig = Partial<Record<CwCommandLane, number>>;

export const DEFAULT_LANE_CONCURRENCY: Record<CwCommandLane, number> = {
  critical: 1,
  im_user: 5,
  a2a: 3,
  schedule: 2,
  autonomy: 1,
  background: 8,
};

/** 推断事件类型归属哪条 Lane */
export function resolveLaneForEventType(eventType: string): CwCommandLane {
  if (
    eventType.startsWith("system.anomaly") ||
    eventType.startsWith("system.runtime") ||
    eventType.startsWith("rbac.denied") ||
    eventType.startsWith("data.delete") ||
    eventType.startsWith("config.security")
  ) {
    return CwCommandLane.Critical;
  }
  if (
    eventType.startsWith("im.") ||
    eventType.startsWith("webhook.") ||
    eventType.startsWith("rest.") ||
    eventType.startsWith("user.")
  ) {
    return CwCommandLane.ImUser;
  }
  if (eventType.startsWith("a2a.")) {
    return CwCommandLane.A2a;
  }
  if (
    eventType.startsWith("system.schedule") ||
    eventType.startsWith("schedule.") ||
    eventType === "system.outbox.retry"
  ) {
    return CwCommandLane.Schedule;
  }
  if (
    eventType.startsWith("autonomy.") ||
    eventType.startsWith("connector.") ||
    eventType.startsWith("evolve.") ||
    eventType.startsWith("learn.")
  ) {
    return CwCommandLane.Autonomy;
  }
  return CwCommandLane.Background;
}

// ── 错误类型（与 OpenClaw 对齐）────────────────────────────────────────────

export class CommandLaneClearedError extends Error {
  constructor(lane?: string) {
    super(lane ? `Command lane "${lane}" cleared` : "Command lane cleared");
    this.name = "CommandLaneClearedError";
  }
}

export class CommandLaneTaskTimeoutError extends Error {
  readonly lane: string;
  readonly timeoutMs: number;
  constructor(lane: string, timeoutMs: number) {
    super(`Command lane "${lane}" task timed out after ${timeoutMs}ms`);
    this.name = "CommandLaneTaskTimeoutError";
    this.lane = lane;
    this.timeoutMs = timeoutMs;
  }
}

// ── 类型 ──────────────────────────────────────────────────────────────────

type QueueEntry<T = unknown> = {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  warnAfterMs: number;
  taskTimeoutMs?: number;
};

type LaneState = {
  lane: string;
  queue: QueueEntry[];
  activeCount: number;
  maxConcurrent: number;
  draining: boolean;
};

export type LaneSnapshot = {
  lane: string;
  queued: number;
  active: number;
  maxConcurrent: number;
};

// ── 调度核心 ─────────────────────────────────────────────────────────────

export type CommandLaneScheduler = {
  /** 将任务排入指定 Lane，返回 Promise<结果> */
  enqueue<T>(
    lane: CwCommandLane,
    task: () => Promise<T>,
    opts?: { taskTimeoutMs?: number; warnAfterMs?: number },
  ): Promise<T>;

  /** 更新 Lane 的最大并发数（运行时可调） */
  setConcurrency(lane: CwCommandLane, maxConcurrent: number): void;

  /** 快照所有 Lane 的当前状态 */
  snapshot(): LaneSnapshot[];

  /** 清空指定 Lane 的等待队列（不取消运行中任务） */
  clearQueue(lane: CwCommandLane): number;

  /** 是否有日志记录器 */
  logger?: (msg: string) => void;
};

export function createCommandLaneScheduler(opts?: {
  concurrency?: LaneConcurrencyConfig;
  logger?: (msg: string) => void;
}): CommandLaneScheduler {
  const lanes = new Map<string, LaneState>();
  const log = opts?.logger;

  function getOrCreateLane(lane: string): LaneState {
    const existing = lanes.get(lane);
    if (existing) return existing;
    const cfg = DEFAULT_LANE_CONCURRENCY[lane as CwCommandLane] ?? 4;
    const overridden = opts?.concurrency?.[lane as CwCommandLane];
    const maxConcurrent = overridden ?? cfg;
    const state: LaneState = { lane, queue: [], activeCount: 0, maxConcurrent, draining: false };
    lanes.set(lane, state);
    return state;
  }

  // 初始化所有 Lane（避免首次访问延迟）
  for (const lane of Object.values(CwCommandLane)) {
    getOrCreateLane(lane);
  }

  async function runWithTimeout<T>(
    lane: string,
    task: () => Promise<T>,
    taskTimeoutMs: number | undefined,
  ): Promise<T> {
    const taskPromise = Promise.resolve().then(task);
    if (!taskTimeoutMs) return taskPromise;

    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      const handle = setTimeout(() => {
        timedOut = true;
        reject(new CommandLaneTaskTimeoutError(lane, taskTimeoutMs));
      }, taskTimeoutMs);
      handle.unref?.();
    });

    try {
      return await Promise.race([taskPromise, timeoutPromise]);
    } catch (err) {
      if (!timedOut) throw err;
      // 让原始 task promise 悄悄完成（不产生 unhandled rejection）
      void taskPromise.catch(() => undefined);
      throw err;
    }
  }

  function drainLane(lane: string): void {
    const state = getOrCreateLane(lane);
    if (state.draining) return;
    state.draining = true;

    const pump = () => {
      try {
        while (state.activeCount < state.maxConcurrent && state.queue.length > 0) {
          const entry = state.queue.shift()!;
          const waitedMs = Date.now() - entry.enqueuedAt;
          if (waitedMs >= entry.warnAfterMs) {
            log?.(
              `[lane:${lane}] queued too long: waited=${waitedMs}ms ahead=${state.queue.length}`,
            );
          }
          state.activeCount++;
          void (async () => {
            try {
              const result = await runWithTimeout(lane, entry.task, entry.taskTimeoutMs);
              entry.resolve(result as unknown);
            } catch (err) {
              entry.reject(err);
            } finally {
              state.activeCount = Math.max(0, state.activeCount - 1);
              pump();
            }
          })();
        }
      } finally {
        if (state.activeCount === 0 && state.queue.length === 0) {
          state.draining = false;
        }
      }
    };

    pump();
  }

  return {
    enqueue<T>(
      lane: CwCommandLane,
      task: () => Promise<T>,
      opts2: { taskTimeoutMs?: number; warnAfterMs?: number } = {},
    ): Promise<T> {
      const state = getOrCreateLane(lane);
      return new Promise<T>((resolve, reject) => {
        state.queue.push({
          task: task as () => Promise<unknown>,
          resolve: resolve as (v: unknown) => void,
          reject,
          enqueuedAt: Date.now(),
          warnAfterMs: opts2.warnAfterMs ?? 5_000,
          taskTimeoutMs: opts2.taskTimeoutMs,
        });
        drainLane(lane);
      });
    },

    setConcurrency(lane, maxConcurrent) {
      const state = getOrCreateLane(lane);
      state.maxConcurrent = Math.max(1, maxConcurrent);
      drainLane(lane);
    },

    snapshot() {
      return [...lanes.values()].map((s) => ({
        lane: s.lane,
        queued: s.queue.length,
        active: s.activeCount,
        maxConcurrent: s.maxConcurrent,
      }));
    },

    clearQueue(lane) {
      const state = lanes.get(lane);
      if (!state) return 0;
      const count = state.queue.length;
      const err = new CommandLaneClearedError(lane);
      for (const entry of state.queue) entry.reject(err);
      state.queue = [];
      return count;
    },

    logger: log,
  };
}

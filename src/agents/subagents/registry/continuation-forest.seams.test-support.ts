// Continuation (karmaterminal/openclaw#1271): the seams the burning-annex world
// (continuation-forest.test-support.ts) installs into the modules it doubles or observes. Suites
// declare each `vi.mock` themselves and delegate here:
//
//   vi.mock("../spawn/subagent-spawn.js", async (importOriginal) =>
//     (await import("./continuation-forest.seams.test-support.js")).withForestSpawnOwner(
//       await importOriginal(),
//     ));
//
// This module imports types only, so a mock factory can load it while the module it mocks is
// still being linked. With no world installed every wrapper is a pass-through.
import type { requestContinuationWake } from "../../../auto-reply/continuation/continuation-wake.js";
import type { getReplyFromConfig } from "../../../auto-reply/reply/get-reply.js";
import type { stopSessionResetSubagents } from "../../../auto-reply/reply/session-reset-cleanup.js";
import type {
  enqueueSessionDelivery,
  QueuedSessionDeliveryPayload,
} from "../../../infra/session-delivery-queue-storage.js";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { sleep } from "../../../utils/sleep.js";
import type { spawnSubagentDirect } from "../spawn/subagent-spawn.js";

type ResetKillParams = Parameters<typeof stopSessionResetSubagents>[0];

/** What the installed world does at each seam. */
export type ContinuationForestSeams = {
  /** The spawn owner: the world admits the child and starts its crane. */
  spawn?: typeof spawnSubagentDirect;
  /** The reply owner: a continue_work wake turn. */
  reply?: typeof getReplyFromConfig;
  /** Continuation return wakes are process-external; the world records them. */
  wake?: typeof requestContinuationWake;
  /** Runs inside a reset, after its retention marks and before upstream's reset kill. */
  beforeResetKill?: (params: ResetKillParams) => Promise<void> | void;
  /** Runs after a durable session-delivery row is written, before its producer continues. */
  afterDeliveryRowWritten?: (payload: QueuedSessionDeliveryPayload, id: string) => Promise<void>;
  /** Every subsystem log line at info level or above. */
  logLine?: (subsystem: string, message: string) => void;
  /** A wait on the clock begins; the returned callback runs when it ends. */
  clockWait?: () => () => void;
};

export const continuationForestSeams: ContinuationForestSeams = {};

export function withForestSpawnOwner<M extends { spawnSubagentDirect: typeof spawnSubagentDirect }>(
  actual: M,
): M {
  return {
    ...actual,
    spawnSubagentDirect: (...args: Parameters<typeof spawnSubagentDirect>) =>
      (continuationForestSeams.spawn ?? actual.spawnSubagentDirect)(...args),
  };
}

export function withForestReplyOwner<M extends { getReplyFromConfig: typeof getReplyFromConfig }>(
  actual: M,
): M {
  return {
    ...actual,
    getReplyFromConfig: (...args: Parameters<typeof getReplyFromConfig>) =>
      (continuationForestSeams.reply ?? actual.getReplyFromConfig)(...args),
  };
}

export function withForestWakeOwner<
  M extends { requestContinuationWake: typeof requestContinuationWake },
>(actual: M): M {
  return {
    ...actual,
    requestContinuationWake: (...args: Parameters<typeof requestContinuationWake>) =>
      (continuationForestSeams.wake ?? actual.requestContinuationWake)(...args),
  };
}

export function withForestResetKill<
  M extends { stopSessionResetSubagents: typeof stopSessionResetSubagents },
>(actual: M): M {
  return {
    ...actual,
    stopSessionResetSubagents: async (params: ResetKillParams) => {
      await continuationForestSeams.beforeResetKill?.(params);
      return await actual.stopSessionResetSubagents(params);
    },
  };
}

export function withForestDeliveryRows<
  M extends { enqueueSessionDelivery: typeof enqueueSessionDelivery },
>(actual: M): M {
  return {
    ...actual,
    enqueueSessionDelivery: async (...args: Parameters<typeof enqueueSessionDelivery>) => {
      const id = await actual.enqueueSessionDelivery(...args);
      await continuationForestSeams.afterDeliveryRowWritten?.(args[0], id);
      return id;
    },
  };
}

export function withForestLogLines<
  M extends { createSubsystemLogger: typeof createSubsystemLogger },
>(actual: M): M {
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      const record =
        (level: "info" | "warn" | "error") => (message: string, meta?: Record<string, unknown>) => {
          continuationForestSeams.logLine?.(subsystem, message);
          logger[level](message, meta);
        };
      return { ...logger, info: record("info"), warn: record("warn"), error: record("error") };
    },
  };
}

export function withForestSleep<M extends { sleep: typeof sleep }>(actual: M): M {
  return {
    ...actual,
    sleep: async (...args: Parameters<typeof sleep>) => {
      const ended = continuationForestSeams.clockWait?.();
      try {
        return await actual.sleep(...args);
      } finally {
        ended?.();
      }
    },
  };
}

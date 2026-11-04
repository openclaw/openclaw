// Continuation (karmaterminal/openclaw#1271): the seams the burning-annex world
// (continuation-forest.test-support.ts) installs into the modules it doubles or observes. Suites
// declare each `vi.mock`, spread the real module and add the seam's overrides:
//
//   const forestSeams = vi.hoisted(() => () => import("./continuation-forest.seams.test-support.js"));
//   vi.mock("../spawn/subagent-spawn.js", async (importOriginal) => {
//     const actual = await importOriginal<typeof import("../spawn/subagent-spawn.js")>();
//     return { ...actual, ...(await forestSeams()).spawnOwner(actual) };
//   });
//
// This module imports types only, so a mock factory can load it while the module it mocks is
// still being linked. With no world installed every override passes through to the real export.
import type { requestContinuationWake } from "../../../auto-reply/continuation/continuation-wake.js";
import type { getReplyFromConfig } from "../../../auto-reply/reply/get-reply.js";
import type {
  enqueueSessionDelivery,
  QueuedSessionDeliveryPayload,
} from "../../../infra/session-delivery-queue-storage.js";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { sleep } from "../../../utils/sleep.js";
import type { spawnSubagentDirect } from "../spawn/subagent-spawn.js";

/** What the installed world does at each seam. */
export type ContinuationForestSeams = {
  /** The spawn owner: the world admits the child and starts its crane. */
  spawn?: typeof spawnSubagentDirect;
  /** The reply owner: a continue_work wake turn. */
  reply?: typeof getReplyFromConfig;
  /** Continuation return wakes are process-external; the world records them. */
  wake?: typeof requestContinuationWake;
  /** Runs after a durable session-delivery row is written, before its producer continues. */
  afterDeliveryRowWritten?: (payload: QueuedSessionDeliveryPayload, id: string) => Promise<void>;
  /** Every subsystem log line at info level or above. */
  logLine?: (subsystem: string, message: string) => void;
  /** A product sleep begins; the returned callback runs when it ends. */
  clockWait?: () => () => void;
};

export const continuationForestSeams: ContinuationForestSeams = {};

export function spawnOwner(actual: { spawnSubagentDirect: typeof spawnSubagentDirect }) {
  return {
    spawnSubagentDirect: (...args: Parameters<typeof spawnSubagentDirect>) =>
      (continuationForestSeams.spawn ?? actual.spawnSubagentDirect)(...args),
  };
}

export function replyOwner(actual: { getReplyFromConfig: typeof getReplyFromConfig }) {
  return {
    getReplyFromConfig: (...args: Parameters<typeof getReplyFromConfig>) =>
      (continuationForestSeams.reply ?? actual.getReplyFromConfig)(...args),
  };
}

export function wakeOwner(actual: { requestContinuationWake: typeof requestContinuationWake }) {
  return {
    requestContinuationWake: (...args: Parameters<typeof requestContinuationWake>) =>
      (continuationForestSeams.wake ?? actual.requestContinuationWake)(...args),
  };
}

export function deliveryRows(actual: { enqueueSessionDelivery: typeof enqueueSessionDelivery }) {
  return {
    enqueueSessionDelivery: async (...args: Parameters<typeof enqueueSessionDelivery>) => {
      const id = await actual.enqueueSessionDelivery(...args);
      await continuationForestSeams.afterDeliveryRowWritten?.(args[0], id);
      return id;
    },
  };
}

export function logLines(actual: { createSubsystemLogger: typeof createSubsystemLogger }) {
  return {
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

export function clock(actual: { sleep: typeof sleep }) {
  return {
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

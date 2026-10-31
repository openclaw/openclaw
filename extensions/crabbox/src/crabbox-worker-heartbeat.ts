import type { SpawnResult } from "openclaw/plugin-sdk/process-runtime";
import {
  crabboxCommandError,
  runCrabboxCommandWithCoordinatorRetry,
  sanitizeCrabboxNotice,
} from "./crabbox-worker-command.js";
import { parseInspectJson, type CrabboxLeaseLifetime } from "./crabbox-worker-inspect.js";
import { heartbeatIntervalMs } from "./crabbox-worker-profile.js";
import { CRABBOX_HEARTBEAT_TIMEOUT_MS } from "./crabbox-worker-timeouts.js";

type HeartbeatContext = {
  binary: string;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  id: string;
  idleTimeout: string;
  provider: string;
  lifetime?: CrabboxLeaseLifetime;
};

type HeartbeatEntry = HeartbeatContext & {
  controller: AbortController;
  failureWarned: boolean;
  pending?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  notice?: string;
};

function providerDoesNotSupportHeartbeat(result: SpawnResult): boolean {
  const output = `${result.stderr}\n${result.stdout}`;
  return (
    result.termination === "exit" &&
    result.code === 2 &&
    /\bprovider=\S+ does not support lease heartbeat\b/iu.test(output)
  );
}

export function createCrabboxHeartbeatManager(dependencies: { warn: (message: string) => void }) {
  const entries = new Map<string, HeartbeatEntry>();
  let disposed = false;
  const isCurrent = (entry: HeartbeatEntry) =>
    !disposed && entries.get(entry.id) === entry && !entry.controller.signal.aborted;
  const warn = (entry: HeartbeatEntry, message: string, retry = true) =>
    dependencies.warn(
      entry.provider === "azure-sandbox"
        ? `${message}; Sandbox idle activity is not being refreshed; ${retry ? "OpenClaw will retry automatically; " : ""}save your work if failures persist`
        : `${message}; cloud worker machines may be reaped after ${entry.idleTimeout} of coordinator-idle time`,
    );
  const observe = (entry: HeartbeatEntry, lifetime?: CrabboxLeaseLifetime) => {
    entry.lifetime = { ...entry.lifetime, ...lifetime };
    const idle = entry.lifetime.idleTimeoutMs;
    if (idle !== undefined) {
      entry.idleTimeout = `${idle}ms`;
      entry.heartbeatIntervalMs = heartbeatIntervalMs(idle);
      entry.heartbeatTimeoutMs = Math.min(
        CRABBOX_HEARTBEAT_TIMEOUT_MS,
        Math.max(1, Math.floor(idle / 2)),
      );
    }
    const notice = lifetime?.policyNotice;
    if (notice && notice !== entry.notice) {
      dependencies.warn(`Crabbox worker lease ${entry.id}: ${notice}`);
      entry.notice = notice;
    }
  };

  const schedule = (entry: HeartbeatEntry, delayMs = entry.heartbeatIntervalMs) => {
    if (!isCurrent(entry)) {
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      entry.pending = heartbeat(entry);
    }, delayMs);
    entry.timer.unref?.();
  };

  const heartbeat = async (entry: HeartbeatEntry): Promise<void> => {
    if (!isCurrent(entry)) {
      return;
    }
    let result: SpawnResult;
    const startedAt = Date.now();
    try {
      result = await runCrabboxCommandWithCoordinatorRetry({
        action: "heartbeat",
        args: [
          "heartbeat",
          "--provider",
          entry.provider,
          "--id",
          entry.id,
          // Sandbox heartbeat refreshes activity without replacing provider-owned idle policy.
          ...(entry.provider === "azure-sandbox" ? [] : ["--idle-timeout", entry.idleTimeout]),
          "--json",
        ],
        binary: entry.binary,
        signal: entry.controller.signal,
        timeoutMs: entry.heartbeatTimeoutMs,
      });
    } catch (error) {
      if (isCurrent(entry) && !entry.failureWarned) {
        entry.failureWarned = true;
        warn(entry, error instanceof Error ? error.message : "Crabbox heartbeat failed");
      }
      schedule(entry);
      return;
    }
    if (!isCurrent(entry)) {
      return;
    }
    if (result.termination === "exit" && result.code === 0) {
      try {
        if (result.stdout.trim()) {
          const inspected = parseInspectJson(result.stdout);
          if (inspected.id !== entry.id) {
            throw new Error("Crabbox heartbeat returned a different lease id");
          }
          observe(entry, inspected.lifetime);
        }
        const notice = sanitizeCrabboxNotice(result.stderr);
        if (notice) {
          observe(entry, { policyNotice: notice });
        }
      } catch (error) {
        if (!entry.failureWarned) {
          warn(
            entry,
            error instanceof Error ? error.message : "Invalid Crabbox heartbeat response",
          );
        }
        entry.failureWarned = true;
        schedule(entry);
        return;
      }
      entry.failureWarned = false;
      schedule(entry);
      return;
    }
    if (providerDoesNotSupportHeartbeat(result)) {
      warn(
        entry,
        `Crabbox provider ${entry.provider} does not support heartbeat for worker lease ${entry.id}`,
        false,
      );
      return;
    }
    if (!entry.failureWarned) {
      entry.failureWarned = true;
      const message = crabboxCommandError("heartbeat", result).message;
      warn(entry, message.replace("(timeout)", `(timeout after ${Date.now() - startedAt} ms)`));
    }
    schedule(entry);
  };

  const stop = async (leaseId: string): Promise<void> => {
    const entry = entries.get(leaseId);
    if (!entry) {
      return;
    }
    entry.controller.abort();
    clearTimeout(entry.timer);
    // Keep the closed owner visible until its child settles: later stop/dispose
    // must join it, and same-lease inspection must not start another heartbeat.
    try {
      await entry.pending;
    } finally {
      if (entries.get(leaseId) === entry) {
        entries.delete(leaseId);
      }
    }
  };

  return {
    start(context: HeartbeatContext): void {
      if (disposed) {
        return;
      }
      const existing = entries.get(context.id);
      if (existing) {
        if (isCurrent(existing)) {
          const previousInterval = existing.heartbeatIntervalMs;
          observe(existing, context.lifetime);
          if (existing.timer && existing.heartbeatIntervalMs < previousInterval) {
            clearTimeout(existing.timer);
            schedule(existing);
          }
        }
        return;
      }
      const entry = { ...context, failureWarned: false, controller: new AbortController() };
      observe(entry, context.lifetime);
      entries.set(context.id, entry);
      schedule(entry, 0);
    },
    stop,
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...entries.keys()].map(stop));
    },
  };
}

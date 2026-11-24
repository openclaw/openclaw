/** An opt-in, read-only foreground request while the selected Usage report backfills. */
import assert from "node:assert/strict";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { generateStoredDeviceIdentity } from "../../src/infra/device-identity-store.ts";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.ts";

export const FOREGROUND_HISTORY = {
  method: "chat.history",
  sessionKey: "agent:research:dashboard:usage-proof-3717",
  sessionId: "usage-proof-3717-0",
  limit: 64,
  maxBytes: 64 * 1024,
  slots: 8,
  spacingMs: 500,
  requestTimeoutMs: 5_000,
} as const;

export type ForegroundHistorySlot = { slot: number; dueAtMs: number } & (
  | { kind: "busy" | "after-backfill" }
  | ({ startedAtMs: number; endedAtMs: number } & (
      | { kind: "ok"; messages: number; messageBytes: number; payloadBytes: number }
      | { kind: "error"; error: string }
    ))
);
export type ForegroundHistoryWindow = {
  partialAtMs: number | undefined;
  completeAtMs: number | undefined;
  slots: ForegroundHistorySlot[];
};

type History = {
  sessionKey: string;
  sessionId: string;
  messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
};

export async function openForegroundHistory(port: number, token: string) {
  const url = "ws://127.0.0.1:" + port;
  const client = await acquireGatewayTestClient(
    {
      url,
      origin: "http://127.0.0.1:" + port,
      token,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      scopes: ["operator.read"],
      deviceIdentity: generateStoredDeviceIdentity(),
      deviceAuthScope: gatewayOriginScope(url),
      sharedStateMode: "read-only",
      requestTimeoutMs: FOREGROUND_HISTORY.requestTimeoutMs,
    },
    {
      timeoutMs: 30_000,
      timeoutMessage: "Foreground history peer did not connect",
      closeMessage: "Foreground history peer disconnected during setup",
    },
  );
  let armed = false;
  let partialAtMs: number | undefined;
  let completeAtMs: number | undefined;
  let pending: Promise<void> | undefined;
  const timers = new Map<number, { timer: NodeJS.Timeout; dueAtMs: number }>();
  const slots: ForegroundHistorySlot[] = [];

  function clearTimers(markAfterBackfill: boolean) {
    for (const [slot, { timer, dueAtMs }] of timers) {
      clearTimeout(timer);
      if (markAfterBackfill) {
        slots.push({ kind: "after-backfill", slot, dueAtMs });
      }
    }
    timers.clear();
  }

  async function read(slot: number, dueAtMs: number) {
    const startedAtMs = performance.now();
    let endedAtMs: number | undefined;
    try {
      const result = await client.request<History>(FOREGROUND_HISTORY.method, {
        agentId: "research",
        sessionKey: FOREGROUND_HISTORY.sessionKey,
        limit: FOREGROUND_HISTORY.limit,
        maxBytes: FOREGROUND_HISTORY.maxBytes,
      });
      endedAtMs = performance.now();
      assert.equal(result.sessionKey, FOREGROUND_HISTORY.sessionKey);
      assert.equal(result.sessionId, FOREGROUND_HISTORY.sessionId);
      assert.equal(result.messages.length, FOREGROUND_HISTORY.limit);
      for (const [role, expected] of [
        ["user", "Check the test runs and summarize the results."],
        ["assistant", "Reviewed the synthetic test logs and recorded the passing checks."],
      ]) {
        assert.equal(
          result.messages.filter(
            (message) =>
              message.role === role &&
              message.content.some((block) => block.type === "text" && block.text === expected),
          ).length,
          FOREGROUND_HISTORY.limit / 2,
        );
      }
      const messageBytes = Buffer.byteLength(JSON.stringify(result.messages));
      assert(messageBytes > 1_024 && messageBytes <= FOREGROUND_HISTORY.maxBytes);
      slots.push({
        kind: "ok",
        slot,
        dueAtMs,
        startedAtMs,
        endedAtMs,
        messages: result.messages.length,
        messageBytes,
        payloadBytes: Buffer.byteLength(JSON.stringify(result)),
      });
    } catch (error) {
      slots.push({
        kind: "error",
        slot,
        dueAtMs,
        startedAtMs,
        endedAtMs: endedAtMs ?? performance.now(),
        error: String(error).replaceAll(token, "[fixture token]"),
      });
    }
  }

  return {
    arm() {
      armed = true;
    },
    observe(partial: string | undefined, atMs: number) {
      if (!armed || completeAtMs !== undefined) {
        return;
      }
      if (!partial) {
        completeAtMs = atMs;
        clearTimers(true);
      } else if (partial === "summarizing" && partialAtMs === undefined) {
        partialAtMs = atMs;
        for (let slot = 1; slot <= FOREGROUND_HISTORY.slots; slot++) {
          const dueAtMs = atMs + slot * FOREGROUND_HISTORY.spacingMs;
          const timer = setTimeout(
            () => {
              timers.delete(slot);
              if (pending) {
                slots.push({ kind: "busy", slot, dueAtMs });
                return;
              }
              pending = read(slot, dueAtMs).finally(() => {
                pending = undefined;
              });
            },
            Math.max(0, dueAtMs - performance.now()),
          );
          timers.set(slot, { timer, dueAtMs });
        }
      }
    },
    async finish(): Promise<ForegroundHistoryWindow> {
      armed = false;
      clearTimers(false);
      await pending;
      return { partialAtMs, completeAtMs, slots: slots.toSorted((a, b) => a.slot - b.slot) };
    },
    async close() {
      armed = false;
      clearTimers(false);
      await client.stopAndWait();
      await pending;
    },
  };
}

function overlappingDurations(window: ForegroundHistoryWindow) {
  const { partialAtMs, completeAtMs } = window;
  const durations = new Map<number, number>();
  if (partialAtMs !== undefined && completeAtMs !== undefined) {
    for (const row of window.slots) {
      if (row.kind === "ok" && row.startedAtMs >= partialAtMs && row.endedAtMs <= completeAtMs) {
        durations.set(row.slot, row.endedAtMs - row.startedAtMs);
      }
    }
  }
  return durations;
}

/** Pair by sample and cadence slot. A post-backfill success cannot improve a percentile. */
export function summarizeForegroundHistory(
  pairs: Array<{ sample: number; base?: ForegroundHistoryWindow; head?: ForegroundHistoryWindow }>,
) {
  const baseLatency: number[] = [];
  const headLatency: number[] = [];
  const coverage = pairs.map(({ sample, base, head }) => {
    const baseOverlap = base ? overlappingDurations(base) : new Map<number, number>();
    const headOverlap = head ? overlappingDurations(head) : new Map<number, number>();
    const matchedSlots = [...baseOverlap.keys()].filter((slot) => headOverlap.has(slot));
    for (const slot of matchedSlots) {
      baseLatency.push(baseOverlap.get(slot)!);
      headLatency.push(headOverlap.get(slot)!);
    }
    const counts = (window: ForegroundHistoryWindow | undefined, overlap: Map<number, number>) => ({
      backfillMs:
        window?.partialAtMs !== undefined && window.completeAtMs !== undefined
          ? window.completeAtMs - window.partialAtMs
          : null,
      attempted:
        window?.slots.filter((row) => row.kind === "ok" || row.kind === "error").length ?? 0,
      overlap: overlap.size,
      notObserved: FOREGROUND_HISTORY.slots - (window?.slots.length ?? 0),
      outsideBackfill:
        (window?.slots.filter((row) => row.kind === "ok").length ?? 0) - overlap.size,
      errors: window?.slots.filter((row) => row.kind === "error").length ?? 0,
      skippedBusy: window?.slots.filter((row) => row.kind === "busy").length ?? 0,
      skippedAfterBackfill:
        window?.slots.filter((row) => row.kind === "after-backfill").length ?? 0,
    });
    return {
      sample,
      base: counts(base, baseOverlap),
      head: counts(head, headOverlap),
      matchedSlots,
    };
  });
  const percentiles = (durations: number[]) => {
    const sorted = durations.toSorted((a, b) => a - b);
    return {
      count: sorted.length,
      p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
      p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
      maxMs: sorted.at(-1) ?? null,
    };
  };
  return {
    coverage,
    base: percentiles(baseLatency),
    head: percentiles(headLatency),
    // Empty or partial coverage is not permission to infer no regression.
    comparable:
      coverage.length > 0 &&
      coverage.every(
        ({ matchedSlots, base, head }) =>
          matchedSlots.length > 0 &&
          !base.errors &&
          !head.errors &&
          !base.skippedBusy &&
          !head.skippedBusy,
      ),
  };
}

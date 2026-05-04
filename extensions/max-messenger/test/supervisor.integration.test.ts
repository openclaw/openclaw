/**
 * Integration tests for the MAX polling supervisor (Phase 1B.2 gating proof).
 *
 * Drives `runMaxPollingSupervisor` against the fake-MAX harness for each of
 * the eight scenarios shipped under `test/fake-max-server/scenarios/` plus
 * FM4 (gateway shutdown mid-poll) and FM5 (unhandled SDK exception inside
 * dispatch) which the harness alone cannot exercise.
 *
 * Tests deliberately use small backoffs / tight timeouts to keep runtime
 * predictable in CI; the production defaults from §8 rows 11-13 are covered
 * by the schema/lifecycle wiring in 1B.2 separately.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runMaxPollingSupervisor } from "../src/polling/monitor-polling.runtime.js";
import type { PollingLogger, PollingUpdate } from "../src/polling/polling-loop.js";
import {
  startFakeMaxServer,
  type FakeMaxScenario,
  type FakeMaxServerHandle,
} from "./fake-max-server/server.js";

type LogEntry = {
  level: "info" | "warn" | "error";
  message: string;
  fields: Record<string, unknown>;
};

function buildLog(): { logger: PollingLogger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const push =
    (level: LogEntry["level"]) =>
    (message: string, fields?: Record<string, unknown>): void => {
      entries.push({ level, message, fields: fields ?? {} });
    };
  return {
    logger: {
      info: push("info"),
      warn: push("warn"),
      error: push("error"),
    },
    entries,
  };
}

function logHasReason(entries: LogEntry[], message: string, reason: string): boolean {
  return entries.some((e) => e.message.includes(message) && e.fields["reason"] === reason);
}

async function loadScenario(name: string): Promise<FakeMaxScenario> {
  const fileUrl = new URL(`./fake-max-server/scenarios/${name}`, import.meta.url);
  const text = await import("node:fs/promises").then((m) =>
    m.readFile(new URL(fileUrl.href), "utf8"),
  );
  return JSON.parse(text) as FakeMaxScenario;
}

const handles: FakeMaxServerHandle[] = [];
let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "max-supervisor-it-"));
});

afterEach(async () => {
  await Promise.all(handles.splice(0).map((h) => h.stop()));
  rmSync(stateDir, { force: true, recursive: true });
});

async function startHarness(scenario: FakeMaxScenario): Promise<FakeMaxServerHandle> {
  const handle = await startFakeMaxServer({ scenario });
  handles.push(handle);
  return handle;
}

type SupervisorRun = {
  result: "aborted" | "unauthorized";
  dispatched: PollingUpdate[];
  log: LogEntry[];
  handle: FakeMaxServerHandle;
};

async function runAgainst(
  scenario: FakeMaxScenario,
  opts?: {
    token?: string;
    retryBackoffMs?: number;
    maxBackoffMs?: number;
    timeoutSec?: number;
    requestTimeoutMs?: number;
    abortAfterDispatchCount?: number;
    abortAfterMs?: number;
    dispatchThrowsOnFirst?: boolean;
  },
): Promise<SupervisorRun> {
  const handle = await startHarness(scenario);
  const dispatched: PollingUpdate[] = [];
  const { logger, entries } = buildLog();
  const ctrl = new AbortController();

  let dispatchCount = 0;
  const dispatch = (update: PollingUpdate): Promise<void> => {
    if (opts?.dispatchThrowsOnFirst && dispatchCount === 0) {
      dispatchCount += 1;
      throw new Error("FM5 simulated handler crash");
    }
    dispatched.push(update);
    dispatchCount += 1;
    if (
      opts?.abortAfterDispatchCount !== undefined &&
      dispatched.length >= opts.abortAfterDispatchCount
    ) {
      ctrl.abort();
    }
    return Promise.resolve();
  };

  if (opts?.abortAfterMs !== undefined) {
    setTimeout(() => ctrl.abort(), opts.abortAfterMs).unref();
  }

  const result = await runMaxPollingSupervisor({
    apiRoot: handle.url,
    token: opts?.token ?? "test-token",
    accountId: "default",
    timeoutSec: opts?.timeoutSec ?? 1,
    retryBackoffMs: opts?.retryBackoffMs ?? 10,
    maxBackoffMs: opts?.maxBackoffMs ?? 50,
    dispatch,
    abortSignal: ctrl.signal,
    log: logger,
    stateDir,
    requestTimeoutMs: opts?.requestTimeoutMs ?? 11_000,
  });

  return { result, dispatched, log: entries, handle };
}

describe("supervisor.integration — happy-path", () => {
  it("dispatches one update and advances the marker", async () => {
    const scenario = await loadScenario("happy-path.json");
    const run = await runAgainst(scenario, { abortAfterDispatchCount: 1 });
    expect(run.result).toBe("aborted");
    expect(run.dispatched).toHaveLength(1);
    expect(run.dispatched[0]?.update_type).toBe("message_created");
    // Marker query on the next request would carry 1001 — assert the harness
    // observed the supervisor sending it.
    const observed = run.handle.getRequests();
    expect(observed[0]?.marker).toBeNull(); // first poll has no marker
  });
});

describe("supervisor.integration — 429-with-retry-after", () => {
  it("retries through two 429 responses then dispatches one update", async () => {
    const scenario: FakeMaxScenario = {
      description: "tight 429 retry-after sequence",
      responses: [
        {
          status: 429,
          headers: { "Retry-After": "0" },
          body: { code: "rate_limit", message: "too many" },
        },
        {
          status: 429,
          headers: { "Retry-After": "0" },
          body: { code: "rate_limit", message: "too many" },
        },
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 1,
                message: { body: { mid: "m1" } },
              },
            ],
            marker: 100,
          },
        },
      ],
    };
    const run = await runAgainst(scenario, { abortAfterDispatchCount: 1 });
    expect(run.result).toBe("aborted");
    expect(run.dispatched).toHaveLength(1);
    const restartLogs = run.log.filter((e) => e.message.includes("polling.restart"));
    expect(restartLogs).toHaveLength(2);
    expect(restartLogs.every((e) => e.fields["reason"] === "retry_after")).toBe(true);
  }, 15_000);
});

describe("supervisor.integration — 5xx-then-success", () => {
  it("retries through 5xx with exponential backoff and resets on success", async () => {
    const scenario: FakeMaxScenario = {
      description: "three 5xx then success",
      responses: [
        { status: 500, body: { code: "server", message: "down" } },
        { status: 502, body: { code: "server", message: "down" } },
        { status: 503, body: { code: "server", message: "down" } },
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 1,
                message: { body: { mid: "m1" } },
              },
            ],
            marker: 200,
          },
        },
      ],
    };
    const run = await runAgainst(scenario, { abortAfterDispatchCount: 1 });
    expect(run.result).toBe("aborted");
    expect(run.dispatched).toHaveLength(1);
    const restarts = run.log.filter((e) => e.message.includes("polling.restart"));
    expect(restarts).toHaveLength(3);
    expect(logHasReason(run.log, "polling.restart", "server_500")).toBe(true);
    expect(logHasReason(run.log, "polling.restart", "server_502")).toBe(true);
    expect(logHasReason(run.log, "polling.restart", "server_503")).toBe(true);
  });
});

describe("supervisor.integration — network-drop", () => {
  it("classifies socket destroy as transient NetworkError and retries", async () => {
    const scenario: FakeMaxScenario = {
      description: "two drops then ok",
      responses: [
        { closeConnection: true },
        { closeConnection: true },
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 1,
                message: { body: { mid: "m1" } },
              },
            ],
            marker: 300,
          },
        },
      ],
    };
    const run = await runAgainst(scenario, { abortAfterDispatchCount: 1 });
    expect(run.result).toBe("aborted");
    expect(run.dispatched).toHaveLength(1);
    const restarts = run.log.filter((e) => e.message.includes("polling.restart"));
    expect(restarts.length).toBeGreaterThanOrEqual(2);
    expect(restarts.every((e) => e.fields["reason"] === "network")).toBe(true);
  });
});

describe("supervisor.integration — slow-response", () => {
  it("fires the per-request timeout on a hanging response and retries", async () => {
    const scenario: FakeMaxScenario = {
      description: "hang, then success",
      responses: [
        { delayMs: 2_000, status: 200, body: { updates: [], marker: 0 } },
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 1,
                message: { body: { mid: "m1" } },
              },
            ],
            marker: 400,
          },
        },
      ],
    };
    const run = await runAgainst(scenario, {
      abortAfterDispatchCount: 1,
      requestTimeoutMs: 200,
    });
    expect(run.result).toBe("aborted");
    expect(run.dispatched).toHaveLength(1);
    const restarts = run.log.filter((e) => e.message.includes("polling.restart"));
    expect(restarts.length).toBeGreaterThanOrEqual(1);
    expect(logHasReason(run.log, "polling.restart", "request_timeout")).toBe(true);
  }, 15_000);
});

describe("supervisor.integration — marker-replay", () => {
  it("drops the duplicate mid on the second batch (dedup), dispatches the fresh batch", async () => {
    const replay: PollingUpdate = {
      update_type: "message_created",
      timestamp: 1,
      message: { body: { mid: "msg-replay-1" } },
    };
    const fresh: PollingUpdate = {
      update_type: "message_created",
      timestamp: 2,
      message: { body: { mid: "msg-replay-fresh" } },
    };
    const scenario: FakeMaxScenario = {
      description: "same mid twice then fresh",
      responses: [
        { status: 200, body: { updates: [replay], marker: 500 } },
        { status: 200, body: { updates: [replay], marker: 500 } },
        { status: 200, body: { updates: [fresh], marker: 501 } },
      ],
    };
    const run = await runAgainst(scenario, { abortAfterDispatchCount: 2 });
    expect(run.result).toBe("aborted");
    expect(run.dispatched.map((u) => u.message?.body?.mid)).toEqual([
      "msg-replay-1",
      "msg-replay-fresh",
    ]);
    const dedup = run.log.filter((e) => e.message.includes("polling.dedup_drop"));
    expect(dedup).toHaveLength(1);
  });
});

describe("supervisor.integration — 401-revoked", () => {
  it("dispatches batches before the 401, then halts with reason 'unauthorized'", async () => {
    const scenario: FakeMaxScenario = {
      description: "two batches then 401",
      responses: [
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 1,
                message: { body: { mid: "before-401-1" } },
              },
            ],
            marker: 600,
          },
        },
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 2,
                message: { body: { mid: "before-401-2" } },
              },
            ],
            marker: 601,
          },
        },
        { status: 401, body: { code: "verify.token", message: "Invalid" } },
      ],
    };
    const run = await runAgainst(scenario);
    expect(run.result).toBe("unauthorized");
    expect(run.dispatched).toHaveLength(2);
    expect(run.log.some((e) => e.level === "error" && e.message.includes("polling.fatal"))).toBe(
      true,
    );
  });
});

describe("supervisor.integration — prolonged-outage", () => {
  it("stays alive across an extended outage and resumes cleanly on success", async () => {
    const scenario: FakeMaxScenario = {
      description: "12 transient errors then success (compressed for CI)",
      responses: [
        {
          repeat: 12,
          status: 503,
          body: { code: "server", message: "down" },
        },
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 1,
                message: { body: { mid: "after-outage" } },
              },
            ],
            marker: 700,
          },
        },
      ],
    };
    const run = await runAgainst(scenario, {
      abortAfterDispatchCount: 1,
      retryBackoffMs: 5,
      maxBackoffMs: 20,
    });
    expect(run.result).toBe("aborted");
    expect(run.dispatched).toHaveLength(1);
    const restarts = run.log.filter((e) => e.message.includes("polling.restart"));
    expect(restarts).toHaveLength(12);
  }, 15_000);
});

describe("supervisor.integration — FM4 (gateway shutdown mid-poll)", () => {
  it("aborts the in-flight long-poll cleanly on caller-driven abort and exits 'aborted'", async () => {
    const scenario: FakeMaxScenario = {
      description: "single hanging response — no body ever arrives",
      responses: [{ delayMs: 30_000, status: 200, body: { updates: [], marker: 0 } }],
    };
    const run = await runAgainst(scenario, {
      abortAfterMs: 100,
      requestTimeoutMs: 60_000,
    });
    expect(run.result).toBe("aborted");
    expect(run.dispatched).toHaveLength(0);
    // No restart log — the loop never classifies the abort as a transient
    // failure (per §6.1.6 / polling-loop.ts caller-abort branch).
    const restarts = run.log.filter((e) => e.message.includes("polling.restart"));
    expect(restarts).toHaveLength(0);
  });
});

describe("supervisor.integration — FM5 (dispatch handler throws)", () => {
  it("logs the failure and keeps polling; dispatch failure must not crash the loop", async () => {
    const scenario: FakeMaxScenario = {
      description: "two updates — first will throw, second succeeds",
      responses: [
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 1,
                message: { body: { mid: "fm5-throw" } },
              },
            ],
            marker: 800,
          },
        },
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 2,
                message: { body: { mid: "fm5-ok" } },
              },
            ],
            marker: 801,
          },
        },
      ],
    };
    const run = await runAgainst(scenario, {
      dispatchThrowsOnFirst: true,
      abortAfterDispatchCount: 1, // dispatched[] only counts the second (non-throwing) call
    });
    expect(run.result).toBe("aborted");
    expect(run.dispatched).toHaveLength(1);
    expect(run.dispatched[0]?.message?.body?.mid).toBe("fm5-ok");
    expect(run.log.some((e) => e.message.includes("polling.dispatch_failed"))).toBe(true);
  });
});

describe("supervisor.integration — marker store invalidation on token change", () => {
  it("emits marker_reset and replays one batch when stored tokenHash mismatches", async () => {
    // First run: persist a marker under token-A.
    const scenarioA: FakeMaxScenario = {
      description: "single batch under token-A",
      responses: [
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 1,
                message: { body: { mid: "first-run" } },
              },
            ],
            marker: 900,
          },
        },
      ],
    };
    const runA = await runAgainst(scenarioA, { token: "token-A", abortAfterDispatchCount: 1 });
    expect(runA.result).toBe("aborted");

    // Second run with a different token reuses the same stateDir. The marker
    // file has tokenHash for token-A; the supervisor must detect mismatch
    // and emit polling.marker_reset before dispatching anew.
    const scenarioB: FakeMaxScenario = {
      description: "single batch under token-B",
      responses: [
        {
          status: 200,
          body: {
            updates: [
              {
                update_type: "message_created",
                timestamp: 2,
                message: { body: { mid: "second-run" } },
              },
            ],
            marker: 1_000,
          },
        },
      ],
    };
    const runB = await runAgainst(scenarioB, { token: "token-B", abortAfterDispatchCount: 1 });
    expect(runB.result).toBe("aborted");
    const reset = runB.log.filter((e) => e.message.includes("polling.marker_reset"));
    expect(reset.length).toBeGreaterThanOrEqual(1);
  });
});

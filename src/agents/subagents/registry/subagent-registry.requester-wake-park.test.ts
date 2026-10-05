// Requester settle wake park (openclaw#154252). Real SQLite store, real
// SubagentLifecycleController and real maybeWakeRequesterAfterAllChildrenSettled,
// entered through the sweeper's resumeRequesterSettleWake. Only the gateway
// transport, session store and logger sink are substituted.

const probe = vi.hoisted(() => ({
  settleCalls: 0,
  settleOk: 0,
  settleErrors: [] as string[],
  settleAt: [] as number[],
  warns: [] as Array<{ msg: string; meta?: Record<string, unknown> }>,
}));

// Explicit logger: the warn sink records every record and nothing reaches a real transport.
vi.mock("../../../logging/subsystem.js", () => {
  const logger = {
    subsystem: "test",
    isEnabled: () => false,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: (msg: string, meta?: Record<string, unknown>) => {
      probe.warns.push({ msg, meta });
    },
    error: () => {},
    fatal: () => {},
    raw: () => {},
    child: () => logger,
  };
  return {
    createSubsystemLogger: () => logger,
    runtimeForLogger: () => ({ log: () => {}, error: () => {}, exit: () => {} }),
  };
});

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { onAgentEvent } from "../../../infra/agent-events.js";
import { openOpenClawStateDatabase } from "../../../state/openclaw-state-db.js";
import "../spawn/subagent-spawn-model.mocks.shared.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { loadAgentRuntimePluginRegistryHandle } from "../../runtime-plugins.js";
import { testing as subagentAnnounceDeliveryTesting } from "../announce/subagent-announce-delivery.test-support.js";
import { testing as subagentAnnounceOutputTesting } from "../announce/subagent-announce-output.test-support.js";
import { announceTesting as subagentAnnounceTesting } from "../announce/subagent-announce-overrides.test-support.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import * as completionStore from "../completion/subagent-completion-admission.store.js";
import { SubagentRegistryWriteError } from "./subagent-registry-persistence.js";
import { saveSubagentRegistryChangesToSqlite } from "./subagent-registry-state.fixture.test-support.js";
import { observeRootWork } from "./subagent-registry.browser-cleanup.test-support.js";
import type {
  GatewayRequest,
  SessionStoreEntry,
} from "./subagent-registry.lifecycle-fixture.test-support.js";
import { createLifecycleWaits } from "./subagent-registry.lifecycle-waits.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import * as registry from "./subagent-registry.test-helpers.js";

const MAIN_REQUESTER_SESSION_KEY = "agent:main:main";
const RUN_ID = "run-154252";
const T0 = Date.UTC(2026, 9, 3, 12, 0, 0);
// The sweeper interval: every step also runs one sweep, as the real 60s resume does.
const TICK_MS = 60_000;
const PARK_AFTER = 5;
const PARK_PROBE_MS = 30 * 60_000;
const OWNER_CHANGED = /subagent completion owner changed before settlement: /;

let sessionStore: Record<string, SessionStoreEntry> = {};
let sessionStorePath: string;
let agentCallObserved = createDeferred();
// Fault injected on a given settle call (1-based), in place of the real settle.
const faults = new Map<number, Error>();

const callGatewayMock = vi.fn(async (request: GatewayRequest) => {
  if (request.method === "agent.wait") {
    return { status: "pending" };
  }
  if (request.method === "chat.history") {
    return { messages: [] };
  }
  if (request.method === "agent") {
    agentCallObserved.resolve();
    agentCallObserved = createDeferred();
    return {
      result: {
        payloads: [{ text: "completion delivered" }],
        deliveryStatus: { status: "sent", resultCount: 1 },
      },
    };
  }
  return {};
});

const loadConfigMock = vi.mocked(getRuntimeConfig);

vi.mock("../../../config/config.js", { spy: true });
vi.mock("../../../gateway/call.js", { spy: true });
vi.mock("../../../infra/agent-events.js", { spy: true });
vi.mock("../../runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../../../plugins/registry-empty.js");
  return {
    loadAgentRuntimePluginRegistryHandle: vi.fn<
      typeof import("../../runtime-plugins.js").loadAgentRuntimePluginRegistryHandle
    >(() => createEmptyPluginRegistry()),
  };
});
vi.mock("../announce/subagent-announce.requester-settle-wake.js", { spy: true });

const { maybeWakeRequesterAfterAllChildrenSettled: wakeRequester } = await vi.importActual<
  typeof import("../announce/subagent-announce.requester-settle-wake.js")
>("../announce/subagent-announce.requester-settle-wake.js");

function createGatewayContext() {
  const recoveryRuntime: GatewayRequestContext["recoveryRuntime"] = {
    dispatchAgent: (params, timeoutMs) => callGateway({ method: "agent", params, timeoutMs }),
    waitForAgent: (params, timeoutMs, signal) =>
      callGateway({ method: "agent.wait", params, timeoutMs, signal }),
    dispatchSessionMethod: (method, params, options) =>
      callGateway({
        method,
        params,
        timeoutMs: options?.timeoutMs,
        signal: options?.signal,
        assertDispatchCurrent: options?.assertCurrent,
      }),
    sendRecoveryNotice: async () => {
      throw new Error("Unexpected recovery notice");
    },
  };
  // Activation binds this context to every row restored at boot, and wake release reads
  // the child's abort controllers through it.
  const context = {
    recoveryRuntime,
    chatAbortControllers: new Map(),
  } as unknown as GatewayRequestContext;
  context.resolveGatewayContext = () => context;
  return context;
}

vi.mock("../../../config/sessions.js", async () => ({
  ...(await import("../../../config/sessions/targets.js")),
  ...(await import("../../../config/sessions/main-session.js")),
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: (key: string) => key.match(/^agent:([^:]+)/)?.[1] ?? "main",
  resolveSessionStorePathCore: () => sessionStorePath,
  resolveMainSessionKey: () => MAIN_REQUESTER_SESSION_KEY,
  updateSessionStore: vi.fn(),
}));

vi.mock("../../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: vi.fn(() => null),
}));

vi.mock("../../../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
}));

vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

type RowSeed = Record<string, unknown>;

const baseRow = (endedAt: number, overrides: RowSeed = {}): RowSeed => ({
  runId: RUN_ID,
  childSessionKey: "agent:main:subagent:child-154252",
  requesterSessionKey: MAIN_REQUESTER_SESSION_KEY,
  requesterDisplayKey: "main",
  requesterAgentId: "main",
  task: "killed child",
  cleanup: "keep",
  createdAt: endedAt - 5_000,
  execution: {
    status: "terminal",
    startedAt: endedAt - 4_000,
    endedAt,
    outcome: { status: "error", error: "killed by operator" },
  },
  endedReason: "subagent-killed",
  expectsCompletionMessage: true,
  completion: { required: true, resultText: "partial result" },
  delivery: { status: "pending" },
  cleanupCompletedAt: endedAt + 1,
  requesterSettleWake: {
    status: "pending",
    attemptCount: 3,
    rearmGeneration: 1,
    batchRunIds: [RUN_ID],
  },
  ...overrides,
});

describe("requester settle wake park (#154252)", () => {
  let previousFastTestEnv: string | undefined;
  let testState: OpenClawTestState;
  let settleRootWork: ReturnType<typeof observeRootWork>;
  const { flushAsync } = createLifecycleWaits(MAIN_REQUESTER_SESSION_KEY);

  // One state directory for the file: booting the real SQLite worker costs most of a
  // test's wall time, so each test clears the rows it wrote instead.
  beforeAll(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    sessionStorePath = testState.statePath("agents", "main", "sessions", "sessions.json");
  });

  afterAll(async () => {
    await testState.cleanup();
  });

  beforeEach(async () => {
    openOpenClawStateDatabase().db.exec("DELETE FROM subagent_runs");
    previousFastTestEnv = process.env.OPENCLAW_TEST_FAST;
    process.env.OPENCLAW_TEST_FAST = "1";
    loadConfigMock.mockReset().mockReturnValue({
      agents: {
        defaults: { subagents: { archiveAfterMinutes: 0 } },
        entries: { main: {}, research: {} },
      },
      session: { mainKey: "main", scope: "per-sender" },
    });
    callGatewayMock.mockClear();
    vi.mocked(callGateway).mockImplementation(callGatewayMock as typeof callGateway);
    vi.mocked(loadAgentRuntimePluginRegistryHandle).mockReset();
    vi.mocked(onAgentEvent).mockImplementation(() => () => {});
    agentCallObserved = createDeferred();
    sessionStore = {
      [MAIN_REQUESTER_SESSION_KEY]: {
        sessionId: "sess-main",
        updatedAt: 1,
        delivery: {
          kind: "external",
          route: { channel: "discord", accountId: "default", target: { to: "user-1" } },
          context: { channel: "discord", to: "user-1", accountId: "default" },
          origin: { provider: "discord", to: "user-1", accountId: "default" },
        },
      },
    };
    await replaceSessionEntry(
      { storePath: sessionStorePath, sessionKey: MAIN_REQUESTER_SESSION_KEY },
      sessionStore[MAIN_REQUESTER_SESSION_KEY]!,
    );
    vi.useFakeTimers();
    settleRootWork = observeRootWork();
    probe.settleCalls = 0;
    probe.settleOk = 0;
    probe.settleErrors.length = 0;
    probe.settleAt.length = 0;
    probe.warns.length = 0;
    faults.clear();
    const settle = completionStore.settleRequesterCompletionBatch;
    vi.spyOn(completionStore, "settleRequesterCompletionBatch").mockImplementation(
      async (params) => {
        probe.settleCalls += 1;
        probe.settleAt.push(Date.now());
        try {
          const fault = faults.get(probe.settleCalls);
          if (fault) {
            // The failures a read-only or locked state database produces, in the wrapper the
            // real write path throws. A read-only state directory hangs the SQLite worker
            // broker under fake timers, and a trigger fails the schema admission check.
            throw new SubagentRegistryWriteError("not-committed", fault);
          }
          const result = await settle(params);
          probe.settleOk += 1;
          return result;
        } catch (error) {
          probe.settleErrors.push(error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    );
    vi.mocked(maybeWakeRequesterAfterAllChildrenSettled).mockImplementation(
      async (params) => await wakeRequester(params),
    );
    subagentAnnounceTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock,
    });
    subagentAnnounceDeliveryTesting.setDepsForTest({
      sendMessage: vi.fn(async () => ({
        channel: "discord",
        to: "user-1",
        via: "direct",
        mediaUrl: null,
        result: { messageId: "unexpected-fallback" },
      })) as never,
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock,
      loadSessionEntry: ({ sessionKey }) => sessionStore[sessionKey],
      getRequesterSessionActivity: (requesterSessionKey: string) => ({
        sessionId: sessionStore[requesterSessionKey]?.sessionId,
        isActive: false,
      }),
    });
    subagentAnnounceOutputTesting.setDepsForTest({
      callGateway: callGatewayMock as typeof import("../../../gateway/call.js").callGateway,
      getRuntimeConfig: loadConfigMock,
      readSubagentSessionEntry: (_storePath, sessionKey) => sessionStore[sessionKey],
      resolveAgentIdFromSessionKey: (key) => key?.match(/^agent:([^:]+)/)?.[1] ?? "main",
      resolveSessionStorePathCore: () => sessionStorePath,
    });
  });

  afterEach(async () => {
    try {
      try {
        await vi.advanceTimersByTimeAsync(0);
      } finally {
        await settleRootWork();
      }
    } finally {
      subagentAnnounceDeliveryTesting.setDepsForTest();
      subagentAnnounceOutputTesting.setDepsForTest();
      subagentAnnounceTesting.setDepsForTest();
      await registry.resetSubagentRegistryForTests({ persist: false });
      vi.useRealTimers();
      vi.restoreAllMocks();
      if (previousFastTestEnv === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFastTestEnv;
      }
    }
  });

  const parkWarns = () => probe.warns.filter((warn) => warn.msg === "requester settle wake parked");

  /** The row exactly as SQLite stores it, not the resident copy. */
  const readRow = (runId = RUN_ID) => loadSubagentRegistryFromSqlite().get(runId);
  const rawRows = () =>
    JSON.stringify(
      openOpenClawStateDatabase().db.prepare("SELECT * FROM subagent_runs ORDER BY run_id").all(),
    );
  const queuedForRequester = () =>
    (
      openOpenClawStateDatabase()
        .db.prepare("SELECT COUNT(*) AS n FROM delivery_queue_entries WHERE session_key = ?")
        .get(MAIN_REQUESTER_SESSION_KEY) as { n: number }
    ).n;

  const tick = async () => {
    const before = probe.settleCalls;
    await vi.advanceTimersByTimeAsync(TICK_MS);
    await registry.testing.sweepOnceForTests();
    await flushAsync();
    return probe.settleCalls - before;
  };
  const tickUntil = async (done: () => boolean, cap = 80) => {
    let ticks = 0;
    while (!done() && ticks < cap) {
      await tick();
      ticks += 1;
    }
    expect(done()).toBe(true);
  };

  const start = async () => {
    vi.setSystemTime(T0);
    await registry.initSubagentRegistry();
    await registry.activateSubagentRegistry(() => createGatewayContext());
  };
  const seed = async (row: RowSeed) => {
    await registry.addSubagentRunForTests(row as never);
  };

  const COHORT = [RUN_ID, `${RUN_ID}-b`];
  const cohortWake = {
    status: "pending",
    attemptCount: 3,
    rearmGeneration: 1,
    batchRunIds: COHORT,
  };
  /** A frozen cohort member present only in SQLite: every settle fails owner-changed. */
  const seedStrandedCohort = async (overrides: RowSeed = {}) => {
    const endedAt = T0 - 3_600_000;
    await seed(
      baseRow(endedAt, {
        endedReason: "subagent-error",
        requesterSettleWake: cohortWake,
        ...overrides,
      }),
    );
    saveSubagentRegistryChangesToSqlite(
      new Map([
        [
          COHORT[1]!,
          baseRow(endedAt, {
            runId: COHORT[1],
            childSessionKey: "agent:main:subagent:child-154252-b",
            requesterSettleWake: cohortWake,
          }) as never,
        ],
      ]),
      [COHORT[1]!],
    );
  };
  const healStrandedCohort = () => saveSubagentRegistryChangesToSqlite(new Map(), [COHORT[1]!]);

  /** One greppable evidence line per scenario. */
  const report = (label: string) => {
    const row = readRow();
    console.log(
      [
        `[154252] ${label}`,
        `settleCalls=${probe.settleCalls} settleOk=${probe.settleOk} settleErrors=${probe.settleErrors.length}`,
        `settleAtSec=${probe.settleAt.map((at) => Math.round((at - T0) / 1000)).join(",")}`,
        `warns=${JSON.stringify(probe.warns.map((warn) => warn.msg))}`,
        `parkWarn=${JSON.stringify(parkWarns().map((warn) => warn.meta))}`,
        `sqliteRow wake=${JSON.stringify(row?.requesterSettleWake)} delivery=${JSON.stringify(row?.delivery)} present=${Boolean(row)}`,
      ].join("\n  "),
    );
  };

  it("spends the documented 330s between the first and fifth rejection before parking", async () => {
    await start();
    await seedStrandedCohort();
    for (let i = 0; i < 400 && parkWarns().length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      await flushAsync();
    }
    expect(parkWarns()).toHaveLength(1);
    expect(probe.settleAt).toHaveLength(PARK_AFTER);
    // The backoff alone: the sweeper's 60s resume is gated by the episode's own deadline.
    expect(probe.settleAt[4]! - probe.settleAt[0]!).toBeGreaterThanOrEqual(330_000);
  });

  it("parks a persistent owner-changed wake after five settles, then probes once per 30 minutes and changes nothing", async () => {
    const endedAt = T0 - 3_600_000;
    await start();
    await seed(
      baseRow(endedAt, { execution: { status: "terminal", startedAt: endedAt - 4_000, endedAt } }),
    );
    const before = rawRows();
    await tickUntil(() => parkWarns().length > 0);
    // Two probes after the park: gaps are the probe interval, whatever the sweeper does between.
    await tickUntil(() => probe.settleErrors.length >= PARK_AFTER + 2);
    report("park: terminal row, execution.outcome undefined");

    expect(probe.settleErrors).toHaveLength(PARK_AFTER + 2);
    for (const message of probe.settleErrors) {
      expect(message).toMatch(OWNER_CHANGED);
    }
    // The sweeper resumes every 60s but the episode's own deadline gates it: probes are at least
    // the probe interval apart, and no more than one sweep late.
    const probeGaps = probe.settleAt
      .slice(PARK_AFTER - 1)
      .map((at, i, all) => at - (all[i - 1] ?? at))
      .slice(1);
    expect(probeGaps).toHaveLength(2);
    for (const gap of probeGaps) {
      expect(gap).toBeGreaterThanOrEqual(PARK_PROBE_MS);
      // The sweeper resumes on 60s ticks, so a probe due between ticks waits up to two of them.
      expect(gap).toBeLessThanOrEqual(PARK_PROBE_MS + 2 * TICK_MS);
    }
    expect(parkWarns()).toHaveLength(1);
    expect(parkWarns()[0]?.meta).toMatchObject({
      signature: "subagent completion owner changed before settlement",
      failures: PARK_AFTER,
      probeIntervalMs: PARK_PROBE_MS,
    });
    // Recovery custody is untouched: same stored bytes, wake and payload retained, no event.
    expect(rawRows()).toBe(before);
    expect(readRow()?.requesterSettleWake).toMatchObject({ status: "pending" });
    expect(readRow()?.delivery?.status).not.toMatch(/failed|suspended/);
    expect(readRow()?.completion?.resultText).toBe("partial result");
    expect(queuedForRequester()).toBe(0);
  });

  it("settles on the next probe once the divergence heals, and the episode clears", async () => {
    await start();
    await seedStrandedCohort();
    await tickUntil(() => parkWarns().length > 0);
    healStrandedCohort();
    const parkedAt = probe.settleAt.at(-1)!;
    await tickUntil(() => probe.settleOk > 0);
    report("park then heal");

    expect(probe.settleAt.at(-1)! - parkedAt).toBeGreaterThanOrEqual(PARK_PROBE_MS);
    expect(readRow()?.requesterSettleWake).toBeUndefined();
    const calls = probe.settleCalls;
    await vi.advanceTimersByTimeAsync(PARK_PROBE_MS * 2);
    await registry.testing.sweepOnceForTests();
    await flushAsync();
    expect(probe.settleCalls).toBe(calls);
    expect(parkWarns()).toHaveLength(1);
  });

  it.each([
    ["locked", () => Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" })],
    [
      "wrapped",
      () =>
        new Error("Queued subagent registry persistence failed", {
          cause: Object.assign(new Error("attempt to write a readonly database"), {
            code: "ERR_SQLITE_ERROR",
          }),
        }),
    ],
  ])(
    "never parks on a %s storage error and the count restarts afterwards",
    async (_label, make) => {
      // Calls 1-4 are owner-changed, 5-7 storage errors, then owner-changed again: four more in
      // a row (calls 8-11) are not five, so the park comes with call 12 and not before.
      for (const call of [5, 6, 7]) {
        faults.set(call, make());
      }
      await start();
      await seedStrandedCohort();
      await tickUntil(() => probe.settleCalls >= 11);
      expect(parkWarns()).toEqual([]);
      await tickUntil(() => parkWarns().length > 0);
      expect(probe.settleCalls).toBe(12);
    },
  );

  it("first boot after an upgrade parks a stranded row after five attempts without touching it", async () => {
    const endedAt = T0 - 3_600_000;
    await start();
    await seed(
      baseRow(endedAt, {
        execution: { status: "terminal", startedAt: endedAt - 4_000, endedAt },
        requesterSettleWake: {
          status: "pending",
          attemptCount: PARK_AFTER,
          rearmGeneration: 1,
          batchRunIds: [RUN_ID],
        },
      }),
    );
    // The gateway restarts: only the stored row survives.
    await registry.resetSubagentRegistryForTests({ persist: false });
    const stored = rawRows();
    probe.settleCalls = 0;
    probe.settleErrors.length = 0;
    probe.settleAt.length = 0;
    probe.warns.length = 0;
    expect(registry.getSubagentRunByRunId(RUN_ID)).toBeUndefined();

    await start();
    await tickUntil(() => parkWarns().length > 0);
    report("first boot after upgrade");
    expect(probe.settleCalls).toBe(PARK_AFTER);
    expect(rawRows()).toBe(stored);
    expect(readRow()?.requesterSettleWake).toMatchObject({ status: "pending" });

    // Another restart spends five fresh attempts and parks again.
    await registry.resetSubagentRegistryForTests({ persist: false });
    probe.settleCalls = 0;
    probe.warns.length = 0;
    await start();
    await tickUntil(() => parkWarns().length > 0);
    expect(probe.settleCalls).toBe(PARK_AFTER);
    expect(rawRows()).toBe(stored);
  });

  it("negative control: a killed child settles in one attempt with no park", async () => {
    await start();
    await seed(baseRow(T0 - 3_600_000, { killReconciliation: { killedAt: T0 - 3_600_000 } }));
    await tickUntil(() => probe.settleOk > 0, 10);
    report("ordinary kill reconciliation");
    expect(probe.settleErrors).toEqual([]);
    expect(probe.settleCalls).toBe(1);
    expect(parkWarns()).toEqual([]);
    expect(readRow()?.requesterSettleWake).toBeUndefined();
  });
});

import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../infra/diagnostic-events.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  isolatedReply as reply,
  isolatedErrorReply,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  prepareQuotaProfiles,
  preparedModelRuntime,
  registerIsolatedHarness,
  registerIsolatedRuntime,
  releaseRuntimeLease,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

type PhaseEvent = Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>;
let clock: number;
let events: PhaseEvent[];
let stop: () => void;
let work: AsyncWorkScope;
beforeEach(() => {
  resetIsolatedCompletionTestState();
  resetDiagnosticEventsForTest();
  clock = 0;
  events = [];
  work = new AsyncWorkScope();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  stop = onTrustedInternalDiagnosticEvent(
    (event) => {
      if (event.type === "diagnostic.phase.completed") {
        events.push(event);
      }
    },
    { include: ["diagnostic.phase.completed"] },
  );
});
async function drain() {
  await work.drain();
  await waitForDiagnosticEventsDrained();
}
afterEach(async () => {
  await drain();
  stop();
  vi.restoreAllMocks();
});
function advance<T>(elapsed: number, result: T): T {
  clock += elapsed;
  return result;
}
const run = (request: Parameters<typeof runIsolatedCompletion>[0] = isolatedRequest()) =>
  work.run(() => runIsolatedCompletion(request));
function expectPhase(details: object, durationMs?: number) {
  expect(events).toEqual([
    expect.objectContaining({
      name: "isolated-completion",
      ...(durationMs === undefined ? {} : { durationMs }),
      details: expect.objectContaining(details),
    }),
  ]);
  expect(JSON.stringify(events)).not.toContain("private");
}

it.each(["cli", "v1", "v2"] as const)("times the %s lifecycle", async (runtime) => {
  for (const [mock, elapsed] of [
    [mocks.acquireAgentRunPreparedModelRuntime, 10],
    [mocks.prepareSimpleCompletionModel, 20],
  ] as const) {
    const implementation = mock.getMockImplementation()!;
    mock.mockImplementation(async () => {
      clock += elapsed;
      return await implementation();
    });
  }
  releaseRuntimeLease.mockImplementation(() => advance(40, undefined));
  const complete = async () => advance(30, reply());
  if (runtime === "cli") {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    mocks.runCliAgent.mockImplementation(async () => advance(30, { payloads: [{ text: "done" }] }));
  } else {
    registerIsolatedRuntime(runtime, complete);
  }
  await run({ ...isolatedRequest(), purpose: "conversation-label" });
  await drain();
  const initialPreparationMs = runtime === "cli" ? 10 : 30;
  expectPhase(
    {
      purpose: "conversation-label",
      provider: "openai",
      model: "gpt-test",
      runtimeKind: runtime === "cli" ? "cli" : "harness",
      outcome: "completed",
      settlementOutcome: "completed",
      attempts: 1,
      initialPreparationMs,
      runtimeDurationMs: 30,
      resultDurationMs: initialPreparationMs + 30,
      settlementDurationMs: 40,
    },
    initialPreparationMs + 70,
  );
});

it.each([
  { outcome: "completed", resultMs: 25, totalMs: 85 },
  { outcome: "aborted", resultMs: 25, totalMs: 85 },
  { outcome: "error", resultMs: 15, totalMs: 55 },
] as const)("joins $outcome tail work", async ({ outcome, resultMs, totalMs }) => {
  const tail = createDeferredCore();
  const controller = new AbortController();
  const failure = new Error("private failure detail");
  const complete = async () => {
    void trackAsyncWork(() => tail.promise);
    clock = resultMs;
    if (outcome === "aborted") {
      controller.abort(failure);
    }
    if (outcome !== "completed") {
      throw failure;
    }
    return reply("private reply");
  };
  if (outcome === "error") {
    mocks.acquireAgentRunPreparedModelRuntime.mockImplementation(complete);
  } else {
    registerIsolatedHarness({ runIsolatedCompletionV2: complete });
  }
  try {
    const pending = run({ ...isolatedRequest(), abortSignal: controller.signal });
    if (outcome === "completed") {
      await expect(pending).resolves.toMatchObject({ text: "private reply" });
      controller.abort(failure);
    } else {
      await expect(pending).rejects.toBe(failure);
    }
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([]);
    expect(releaseRuntimeLease).not.toHaveBeenCalled();
    clock = totalMs;
    tail.resolve();
    await drain();
    expectPhase(
      {
        outcome,
        settlementOutcome: "completed",
        resultDurationMs: resultMs,
        settlementDurationMs: totalMs - resultMs,
        ...(outcome === "error"
          ? { attempts: 0, initialPreparationMs: 15, runtimeDurationMs: 0 }
          : {}),
      },
      totalMs,
    );
    if (outcome === "error") {
      expect(events[0]?.details).not.toHaveProperty("runtimeKind");
    }
  } finally {
    tail.resolve();
  }
});

it("does not emit phases when the admitted config disables diagnostics", async () => {
  Object.assign(preparedModelRuntime, { config: { diagnostics: { enabled: false } } });
  registerIsolatedHarness({ runIsolatedCompletionV2: async () => reply() });
  await run();
  await drain();
  expect(events).toEqual([]);
});

it("records release failure separately without changing the completed result", async () => {
  releaseRuntimeLease.mockRejectedValue(new Error("private cleanup failure"));
  registerIsolatedHarness({ runIsolatedCompletionV2: async () => reply() });
  await expect(run()).resolves.toMatchObject({ text: "done" });
  await drain();
  expectPhase({ outcome: "completed", settlementOutcome: "error" });
});

it("aggregates profile attempts into one phase without duplicate completion observations", async () => {
  prepareQuotaProfiles();
  let attempts = 0;
  registerIsolatedHarness({
    authBootstrap: "harness",
    runIsolatedCompletionV2: async () => {
      clock += 20;
      return ++attempts === 1 ? isolatedErrorReply("429 Too many requests") : reply();
    },
  });
  await run();
  await drain();
  expectPhase({ outcome: "completed", attempts: 2, runtimeDurationMs: 40, resultDurationMs: 40 });
});

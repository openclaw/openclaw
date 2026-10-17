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
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  nativeAuthPlan,
  preparedModelRuntime,
  registerIsolatedHarness,
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

afterEach(async () => {
  await work.drain();
  await waitForDiagnosticEventsDrained();
  stop();
  vi.restoreAllMocks();
});

async function drain() {
  await work.drain();
  await waitForDiagnosticEventsDrained();
}

it.each(["cli", "v1", "v2"] as const)(
  "records one phase after %s preparation, dispatch, and release",
  async (runtime) => {
    const acquire = mocks.acquireAgentRunPreparedModelRuntime.getMockImplementation()!;
    mocks.acquireAgentRunPreparedModelRuntime.mockImplementation(async () => {
      clock += 10;
      return await acquire();
    });
    const prepare = mocks.prepareSimpleCompletionModel.getMockImplementation()!;
    mocks.prepareSimpleCompletionModel.mockImplementation(async () => {
      clock += 20;
      return await prepare();
    });
    releaseRuntimeLease.mockImplementation(() => {
      clock += 40;
    });
    const complete = async () => {
      clock += 30;
      return { assistant: isolatedAssistant([{ type: "text", text: "done" }]) };
    };
    if (runtime === "cli") {
      mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
      mocks.runCliAgent.mockImplementation(async () => {
        clock += 30;
        return { payloads: [{ text: "done" }] };
      });
    } else {
      registerIsolatedHarness(
        runtime === "v1"
          ? { runIsolatedCompletion: complete }
          : { runIsolatedCompletionV2: complete },
      );
    }
    await work.run(() =>
      runIsolatedCompletion({ ...isolatedRequest(), purpose: "conversation-label" }),
    );
    await drain();
    const initialPreparationMs = runtime === "cli" ? 10 : 30;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      name: "isolated-completion",
      durationMs: initialPreparationMs + 70,
      details: {
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
    });
  },
);

it.each(["completed", "aborted"] as const)(
  "retains the %s outcome while tracked work outlives the result",
  async (outcome) => {
    const tail = createDeferredCore();
    const controller = new AbortController();
    const failure = new Error("private failure detail");
    registerIsolatedHarness({
      runIsolatedCompletionV2: async () => {
        void trackAsyncWork(() => tail.promise);
        clock = 25;
        if (outcome === "aborted") {
          controller.abort(failure);
          throw failure;
        }
        return { assistant: isolatedAssistant([{ type: "text", text: "private reply" }]) };
      },
    });
    try {
      const pending = work.run(() =>
        runIsolatedCompletion({ ...isolatedRequest(), abortSignal: controller.signal }),
      );
      if (outcome === "aborted") {
        await expect(pending).rejects.toBe(failure);
      } else {
        await expect(pending).resolves.toMatchObject({ text: "private reply" });
        controller.abort(failure);
      }
      await waitForDiagnosticEventsDrained();
      expect(events).toEqual([]);
      expect(releaseRuntimeLease).not.toHaveBeenCalled();
      clock = 85;
      tail.resolve();
      await drain();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        durationMs: 85,
        details: {
          outcome,
          settlementOutcome: "completed",
          resultDurationMs: 25,
          settlementDurationMs: 60,
        },
      });
      expect(JSON.stringify(events)).not.toContain("private");
    } finally {
      tail.resolve();
    }
  },
);

it("joins work from failed acquisition before emitting a preparation-only phase", async () => {
  const tail = createDeferredCore();
  const failure = new Error("private credential preparation failure");
  mocks.acquireAgentRunPreparedModelRuntime.mockImplementation(async () => {
    void trackAsyncWork(() => tail.promise);
    clock = 15;
    throw failure;
  });
  try {
    await expect(work.run(() => runIsolatedCompletion(isolatedRequest()))).rejects.toBe(failure);
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([]);
    clock = 55;
    tail.resolve();
    await drain();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      durationMs: 55,
      details: {
        outcome: "error",
        settlementOutcome: "completed",
        attempts: 0,
        initialPreparationMs: 15,
        runtimeDurationMs: 0,
        resultDurationMs: 15,
        settlementDurationMs: 40,
      },
    });
    expect(events[0]?.details).not.toHaveProperty("runtimeKind");
    expect(JSON.stringify(events)).not.toContain("private");
  } finally {
    tail.resolve();
  }
});

it("does not emit phases when the admitted config disables diagnostics", async () => {
  Object.assign(preparedModelRuntime, { config: { diagnostics: { enabled: false } } });
  registerIsolatedHarness({
    runIsolatedCompletionV2: async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "done" }]),
    }),
  });
  await work.run(() => runIsolatedCompletion(isolatedRequest()));
  await drain();
  expect(events).toEqual([]);
});

it("records release failure separately without changing the completed result", async () => {
  releaseRuntimeLease.mockRejectedValue(new Error("private cleanup failure"));
  registerIsolatedHarness({
    runIsolatedCompletionV2: async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "done" }]),
    }),
  });
  await expect(work.run(() => runIsolatedCompletion(isolatedRequest()))).resolves.toMatchObject({
    text: "done",
  });
  await drain();
  expect(events).toHaveLength(1);
  expect(events[0]?.details).toMatchObject({
    outcome: "completed",
    settlementOutcome: "error",
  });
  expect(JSON.stringify(events)).not.toContain("private");
});

it("aggregates profile attempts into one phase without duplicate completion observations", async () => {
  const profileIds = ["openai:first", "openai:backup"];
  mocks.ensureAuthProfileStore.mockReturnValue({
    version: 1,
    profiles: Object.fromEntries(
      profileIds.map((id) => [id, { type: "token", provider: "openai", token: id }]),
    ),
  });
  mocks.prepareAgentRuntimeAuth.mockReturnValue({
    plan: nativeAuthPlan,
    attempts: profileIds.map((profileId) => ({
      kind: "profile",
      profileId,
      plan: { ...nativeAuthPlan, forwardedAuthProfileId: profileId },
    })),
  });
  let attempts = 0;
  registerIsolatedHarness({
    authBootstrap: "harness",
    runIsolatedCompletionV2: async () => {
      clock += 20;
      if (++attempts === 1) {
        return {
          assistant: {
            ...isolatedAssistant([], "error"),
            errorMessage: "429 Too many requests",
          },
        };
      }
      return { assistant: isolatedAssistant([{ type: "text", text: "done" }]) };
    },
  });
  await work.run(() => runIsolatedCompletion(isolatedRequest()));
  await drain();
  expect(events).toHaveLength(1);
  expect(events[0]?.details).toMatchObject({
    outcome: "completed",
    attempts: 2,
    runtimeDurationMs: 40,
    resultDurationMs: 40,
  });
});

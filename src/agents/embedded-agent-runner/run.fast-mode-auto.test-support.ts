import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
} from "./run.overflow-compaction.harness.js";
import {
  createFreshRunIntegrationState,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;
let resetAgentEventsForTest: typeof import("../../infra/agent-events.js").resetAgentEventsForTest;

type AttemptParams = Parameters<typeof mockedRunEmbeddedAttempt>[0];

function resolveAttemptFastMode({ fastMode }: AttemptParams): void {
  if (typeof fastMode === "function") {
    fastMode();
  }
}

async function startFastAttempt(overrides: Partial<Parameters<typeof runEmbeddedAgent>[0]>) {
  vi.useFakeTimers();
  const base = createOverflowRunParams(state);
  const events: Array<{ data?: { summary?: unknown } }> = [];
  const toolResults: Array<{ text?: string; channelData?: Record<string, unknown> }> = [];
  const globalSummaries: string[] = [];
  const stopCapture = onAgentEvent((event) => {
    if (
      event.runId === (overrides.runId ?? base.runId) &&
      event.stream === "item" &&
      typeof event.data.summary === "string"
    ) {
      globalSummaries.push(event.data.summary);
    }
  });
  const done = createDeferred<EmbeddedRunAttemptResult>();
  const started = createDeferred<AttemptParams>();
  mockedRunEmbeddedAttempt.mockImplementationOnce(async (input) => {
    resolveAttemptFastMode(input);
    started.resolve(input);
    return done.promise;
  });
  const run = runEmbeddedAgent({
    ...base,
    provider: "ollama",
    model: "glm-5.1:cloud",
    fastMode: "auto",
    fastModeAutoOnSeconds: 30,
    ...overrides,
    onAgentEvent: (event) => {
      events.push(event);
      return overrides.onAgentEvent?.(event);
    },
    onToolResult: (payload) => {
      toolResults.push(payload);
      return overrides.onToolResult?.(payload);
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  const params = await started.promise;
  return {
    events,
    toolResults,
    globalSummaries,
    params,
    run,
    complete: () => done.resolve(makeAttemptResult()),
    summaries: () => events.map((event) => event.data?.summary).filter(Boolean),
    texts: () => toolResults.map((payload) => payload.text),
    async [Symbol.asyncDispose]() {
      done.resolve(makeAttemptResult());
      try {
        await run;
      } finally {
        stopCapture();
      }
    },
  };
}

describe("runEmbeddedAgent fast auto progress", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    ({ onAgentEvent, resetAgentEventsForTest } = await import("../../infra/agent-events.js"));
  });

  beforeEach(async () => {
    state = await createFreshRunIntegrationState("run.fast-mode-auto");
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetAgentEventsForTest();
    await state?.cleanup();
  });

  it("dispatches ultrafast without resolving it as auto", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    await runEmbeddedAgent({ ...createOverflowRunParams(state), fastMode: "ultrafast" });
    expect(mockedRunEmbeddedAttempt.mock.calls[0]?.[0].fastMode).toBe("ultrafast");
  });

  it.each([
    [undefined, 23],
    [30, 30],
  ] as const)(
    "emits auto-off once at a completed boundary with cutoff %s, then resets",
    async (cutoff, expected) => {
      const config = {
        agents: {
          defaults: { models: { "ollama/glm-5.1:cloud": { params: { fastAutoOnSeconds: 23 } } } },
        },
      };
      const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
      setRuntimeConfigSnapshot(config);
      await using attempt = await startFastAttempt({
        runId: "run-fast-auto-retry",
        config,
        fastModeAutoOnSeconds: cutoff,
      });
      const { events, toolResults, run, complete, summaries, texts, params, globalSummaries } =
        attempt;
      expect(params.fastModeAutoOnSeconds).toBe(expected);
      const offText = `💨Fast: auto-off(31s>=${expected}s)`;
      const expectSilent = (expectedTexts: string[] = [], emptyEvents = false) => {
        expect(summaries()).toEqual([]);
        expect(texts()).toEqual(expectedTexts);
        expect(globalSummaries).toEqual([]);
        if (emptyEvents) {
          expect(events).toEqual([]);
        }
      };
      const toolPhase = (phase: string) =>
        params?.onAgentEvent?.({
          stream: "tool",
          data: { phase, name: "exec" },
        });
      await vi.advanceTimersByTimeAsync(31_000);
      expectSilent();
      params?.onRunProgress?.({ reason: "model-progress" });
      await vi.advanceTimersByTimeAsync(2);
      expectSilent([], true);
      await params?.onToolResult?.({ text: "🛠️ Exec: still running" });
      await toolPhase("start");
      await toolPhase("result");
      await vi.advanceTimersByTimeAsync(2);
      expectSilent(["🛠️ Exec: still running"]);
      await params?.onToolStreamBoundary?.();
      await vi.advanceTimersByTimeAsync(2);
      for (const output of [summaries(), globalSummaries, texts()]) {
        expect(output).toContain(offText);
      }
      expect(toolResults.at(-1)?.channelData?.openclawProgressKind).toBe("fast-mode-auto");

      await vi.advanceTimersByTimeAsync(14_000);
      await toolPhase("result");
      await params?.onToolStreamBoundary?.();
      await params?.onToolResult?.({ text: "🛠️ Exec: later tool summary" });
      complete();
      await run;

      const autoOff = (text: unknown) =>
        typeof text === "string" && text.includes("Fast: auto-off");
      expect(summaries().filter(autoOff)).toEqual([offText]);
      expect(texts().filter(autoOff)).toEqual([offText]);
      for (const output of [summaries(), texts(), globalSummaries]) {
        expect(output).toContain("💨Fast: auto-on");
      }
    },
  );

  it.each(["agent-event", "tool-result"] as const)(
    "keeps successful runs when fast auto-off %s delivery fails",
    async (failureTarget) => {
      const rejectProgress = (target: typeof failureTarget, summary: unknown) => {
        if (
          failureTarget === target &&
          typeof summary === "string" &&
          summary.startsWith("💨Fast: auto-off")
        ) {
          throw new Error("auto-off delivery failed");
        }
      };
      await using attempt = await startFastAttempt({
        runId: `run-fast-auto-off-${failureTarget}`,
        fastModeAutoOnSeconds: undefined,
        timeoutMs: 120_000,
        onAgentEvent: (event) => rejectProgress("agent-event", event.data?.summary),
        onToolResult: (payload) => rejectProgress("tool-result", payload.text),
      });
      const { run, complete, summaries, texts, params } = attempt;
      await vi.advanceTimersByTimeAsync(61_000);
      await params?.onAgentEvent?.({
        stream: "tool",
        data: { phase: "result", name: "exec" },
      });
      await params?.onToolStreamBoundary?.();

      complete();
      await expect(run).resolves.toBeTruthy();

      expect(summaries()).toContainEqual(expect.stringMatching(/^💨Fast: auto-off\(/u));
      if (failureTarget === "tool-result") {
        expect(texts()).toContainEqual(expect.stringMatching(/^💨Fast: auto-off\(/u));
      }
    },
  );
});

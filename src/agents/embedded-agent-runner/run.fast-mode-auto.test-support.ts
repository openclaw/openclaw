import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentEventPayload } from "../../infra/agent-events.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let onAgentEvent: typeof import("../../infra/agent-events.js").onAgentEvent;
let resetAgentEventsForTest: typeof import("../../infra/agent-events.js").resetAgentEventsForTest;

function successAttempt(): EmbeddedRunAttemptResult {
  return makeAttemptResult({
    assistantTexts: ["done"],
    lastAssistant: {
      stopReason: "stop",
      provider: "ollama",
      model: "glm-5.1:cloud",
      content: [{ type: "text", text: "done" }],
      usage: { input: 100, output: 5, totalTokens: 105 },
    } as unknown as EmbeddedRunAttemptResult["lastAssistant"],
  });
}

type AttemptParams = Parameters<typeof mockedRunEmbeddedAttempt>[0];

function resolveAttemptFastMode({ fastMode }: AttemptParams): void {
  if (typeof fastMode === "function") {
    fastMode();
  }
}

async function startFastAttempt(overrides: Partial<Parameters<typeof runEmbeddedAgent>[0]>) {
  vi.useFakeTimers();
  const events: Array<{ data?: { summary?: unknown } }> = [];
  const toolResults: Array<{ text?: string; channelData?: Record<string, unknown> }> = [];
  const done = createDeferred<EmbeddedRunAttemptResult>();
  const started = createDeferred();
  let params: AttemptParams | undefined;
  mockedRunEmbeddedAttempt.mockImplementationOnce(async (input) => {
    params = input;
    resolveAttemptFastMode(input);
    started.resolve();
    return done.promise;
  });
  const run = runEmbeddedAgent({
    ...createOverflowRunParams(state),
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
  await started.promise;
  expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
  return {
    events,
    toolResults,
    run,
    complete: () => done.resolve(successAttempt()),
    summaries: () => events.map((event) => event.data?.summary).filter(Boolean),
    texts: () => toolResults.map((payload) => payload.text),
    get params() {
      return params;
    },
  };
}

describe("runEmbeddedAgent fast auto progress", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    ({ onAgentEvent, resetAgentEventsForTest } = await import("../../infra/agent-events.js"));
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.fast-mode-auto" });
    const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
    setRuntimeConfigSnapshot({});
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    resetAgentEventsForTest();
    await state?.cleanup();
  });

  it.each(["ultrafast", "auto"] as const)(
    "dispatches %s with its selected policy",
    async (fastMode) => {
      let attemptParams: AttemptParams | undefined;
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (params) => {
        attemptParams = params;
        if (fastMode === "auto") {
          resolveAttemptFastMode(params);
        }
        return successAttempt();
      });
      const config =
        fastMode === "auto"
          ? {
              agents: {
                defaults: {
                  models: {
                    "ollama/glm-5.1:cloud": { params: { fastAutoOnSeconds: 23 } },
                  },
                },
              },
            }
          : {};
      const { setRuntimeConfigSnapshot } = await import("../../config/runtime-snapshot.js");
      setRuntimeConfigSnapshot(config);
      await runEmbeddedAgent({
        ...createOverflowRunParams(state),
        ...(fastMode === "auto" ? { provider: "ollama", model: "glm-5.1:cloud", config } : {}),
        fastMode,
      });
      if (fastMode === "auto") {
        expect(attemptParams?.fastModeAutoOnSeconds).toBe(23);
      } else {
        expect(attemptParams?.fastMode).toBe("ultrafast");
      }
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
    },
  );

  it("emits auto-off once at the first completed boundary past the threshold, then resets", async () => {
    const globalSummaries: string[] = [];
    const stopGlobalCapture = onAgentEvent((event: AgentEventPayload) => {
      if (event.runId !== "run-fast-auto-retry" || event.stream !== "item") {
        return;
      }
      const summary = event.data.summary;
      if (typeof summary === "string") {
        globalSummaries.push(summary);
      }
    });
    const attempt = await startFastAttempt({ runId: "run-fast-auto-retry" });
    const { events, toolResults, run, complete, summaries, texts, params } = attempt;
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
    try {
      await vi.advanceTimersByTimeAsync(31_000);
      expectSilent();
      params?.onRunProgress?.({ reason: "model-progress" });
      await vi.advanceTimersByTimeAsync(2);
      expectSilent([], true);
      await params?.onToolResult?.({ text: "🛠️ Exec: still running" });
      await vi.advanceTimersByTimeAsync(2);
      expectSilent(["🛠️ Exec: still running"]);
      await toolPhase("start");
      await vi.advanceTimersByTimeAsync(2);
      expectSilent(["🛠️ Exec: still running"]);
      await toolPhase("result");
      await vi.advanceTimersByTimeAsync(2);
      expect(summaries()).toEqual([]);
      expect(globalSummaries).toHaveLength(0);
      await params?.onToolStreamBoundary?.();
      await vi.advanceTimersByTimeAsync(2);
      expect(summaries()).toContain("💨Fast: auto-off(31s>=30s)");
      expect(globalSummaries).toContain("💨Fast: auto-off(31s>=30s)");
      expect(texts()).toContain("💨Fast: auto-off(31s>=30s)");
      expect(toolResults.at(-1)?.channelData?.openclawProgressKind).toBe("fast-mode-auto");

      await vi.advanceTimersByTimeAsync(14_000);
      await toolPhase("result");
      await params?.onToolStreamBoundary?.();
      await params?.onToolResult?.({ text: "🛠️ Exec: later tool summary" });
      complete();
      await run;

      const autoOff = (text: unknown) =>
        typeof text === "string" && text.includes("Fast: auto-off");
      expect(summaries().filter(autoOff)).toEqual(["💨Fast: auto-off(31s>=30s)"]);
      expect(texts().filter(autoOff)).toEqual(["💨Fast: auto-off(31s>=30s)"]);
      expect(params?.fastModeAutoProgressState).toMatchObject({
        offAnnounced: true,
        resetAnnounced: true,
      });
      expect(summaries()).toContain("💨Fast: auto-on");
      expect(texts()).toContain("💨Fast: auto-on");
      expect(globalSummaries).toContain("💨Fast: auto-on");
    } finally {
      complete();
      try {
        await run;
      } finally {
        stopGlobalCapture();
      }
    }
  });

  it.each(["agent-event", "tool-result"] as const)(
    "keeps successful runs when fast auto-off %s delivery fails",
    async (failureTarget) => {
      const attempt = await startFastAttempt({
        runId: `run-fast-auto-off-${failureTarget}`,
        fastModeAutoOnSeconds: undefined,
        timeoutMs: 120_000,
        onAgentEvent: (event) => {
          const summary = event.data?.summary;
          if (
            failureTarget === "agent-event" &&
            typeof summary === "string" &&
            summary.startsWith("💨Fast: auto-off")
          ) {
            throw new Error("auto-off event delivery failed");
          }
        },
        onToolResult: (payload) => {
          if (failureTarget === "tool-result" && payload.text?.startsWith("💨Fast: auto-off")) {
            throw new Error("auto-off tool delivery failed");
          }
        },
      });
      const { run, complete, summaries, texts, params } = attempt;
      try {
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
      } finally {
        complete();
        await run;
      }
    },
  );
});

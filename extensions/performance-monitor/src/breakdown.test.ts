// Performance breakdown tests cover per-turn aggregation behavior.
import { describe, expect, it } from "vitest";
import { buildRunPerformanceBreakdown } from "./breakdown.js";
import type { RunPerformanceTrace } from "./types.js";

function sampleTrace(
  events: RunPerformanceTrace["events"],
  totalDurationMs = 2000,
): RunPerformanceTrace {
  return {
    runId: "run-1",
    startedAt: 1,
    updatedAt: 2,
    totalDurationMs,
    events,
    summary: {
      hookHandlerCount: 0,
      totalHookHandlerMs: 0,
      phaseCount: 0,
      totalPhaseMs: 0,
      toolCallCount: 0,
      totalToolMs: 0,
      llmCallCount: 0,
      totalLlmMs: 0,
    },
    breakdown: {
      phases: [],
      hookHandlers: [],
      tools: [],
      llmCalls: [],
      byExtension: [],
      categoryTotals: {
        phaseMs: 0,
        hookHandlerMs: 0,
        toolMs: 0,
        llmMs: 0,
        harnessMs: 0,
        measuredMs: 0,
      },
    },
  };
}

describe("buildRunPerformanceBreakdown", () => {
  it("groups hook, tool, llm, and phase timing for one turn", () => {
    const breakdown = buildRunPerformanceBreakdown(
      sampleTrace([
        { kind: "phase", at: 1, phaseName: "prompt_build", durationMs: 120 },
        {
          kind: "hook_handler",
          at: 2,
          extensionId: "active-memory",
          hookName: "before_prompt_build",
          handlerName: "buildPrompt",
          handlerRef: "hook:active-memory:before_prompt_build@buildPrompt",
          durationMs: 42,
        },
        {
          kind: "tool",
          at: 3,
          extensionId: "browser",
          toolName: "browser_navigate",
          handlerRef: "plugin:browser:browser_navigate",
          durationMs: 300,
        },
        {
          kind: "llm",
          at: 4,
          extensionId: "openai",
          provider: "openai",
          model: "gpt-5.5",
          handlerRef: "provider-plugin:openai/responses",
          durationMs: 1500,
        },
      ]),
    );

    expect(breakdown.phases).toEqual([
      expect.objectContaining({ key: "prompt_build", totalMs: 120, count: 1 }),
    ]);
    expect(breakdown.hookHandlers[0]).toMatchObject({
      key: "hook:active-memory:before_prompt_build@buildPrompt",
      label: "active-memory → before_prompt_build → buildPrompt",
      totalMs: 42,
    });
    expect(breakdown.tools[0]).toMatchObject({
      key: "plugin:browser:browser_navigate",
      label: "browser → browser_navigate",
      totalMs: 300,
    });
    expect(breakdown.llmCalls[0]).toMatchObject({
      key: "provider-plugin:openai/responses",
      totalMs: 1500,
    });
    expect(breakdown.categoryTotals).toMatchObject({
      phaseMs: 120,
      hookHandlerMs: 42,
      toolMs: 300,
      llmMs: 1500,
      measuredMs: 1962,
      totalDurationMs: 2000,
      unaccountedMs: 38,
    });
  });

  it("sorts entries by total duration descending", () => {
    const breakdown = buildRunPerformanceBreakdown(
      sampleTrace([
        {
          kind: "hook_handler",
          at: 1,
          extensionId: "a",
          hookName: "slow",
          durationMs: 90,
        },
        {
          kind: "hook_handler",
          at: 2,
          extensionId: "b",
          hookName: "fast",
          durationMs: 10,
        },
      ]),
    );

    expect(breakdown.hookHandlers.map((entry) => entry.key)).toEqual([
      "hook:a:slow",
      "hook:b:fast",
    ]);
  });
});

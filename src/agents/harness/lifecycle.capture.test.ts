// Verifies harness lifecycle content capture on harness and child run diagnostics.
import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { resetAgentEventsForTest } from "../../infra/agent-events.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { runWithDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import {
  runAgentHarnessLifecycleAttempt,
  runAgentHarnessLifecycleFinalization,
} from "./lifecycle.js";
import {
  captureDiagnosticEvents,
  createAttemptParams,
  createAttemptResult,
  createDiagnosticTrace,
  createFinalAssistant,
  createFinalizationParams,
  flushDiagnosticEvents,
} from "./lifecycle.test-support.js";
import type { AgentHarness } from "./types.js";

describe("AgentHarness lifecycle content capture", () => {
  afterEach(() => {
    resetAgentEventsForTest();
    clearRuntimeConfigSnapshot();
    resetDiagnosticEventsForTest();
  });

  it("captures the finalization assistant answer under captureContent", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    const params = createFinalizationParams();
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      supports: () => ({ supported: true }),
      runAttempt: async () => createAttemptResult(),
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await runAgentHarnessLifecycleFinalization(harness, params, async () => ({
        assistant: createFinalAssistant(),
      }));
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
      clearRuntimeConfigSnapshot();
    }

    const completed = diagnostics.events.find(
      ({ event }) => event.type === "harness.run.completed",
    );
    expect(completed?.privateData.harnessContent).toMatchObject({ finalResponse: "done" });
  });

  it.each(["attempt", "finalization"] as const)(
    "forwards captured content to the plugin harness child run span (%s)",
    async (operation) => {
      setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
      const harness: AgentHarness = {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true }),
        runAttempt: async () => ({
          ...createAttemptResult(),
          currentAttemptAssistant: createFinalAssistant(),
          currentAttemptCompletedAssistant: createFinalAssistant(),
        }),
      };
      const diagnostics = captureDiagnosticEvents((event) => event.type === "run.completed");
      try {
        await runWithDiagnosticTraceContext(createDiagnosticTrace(), () =>
          operation === "attempt"
            ? runAgentHarnessLifecycleAttempt(harness, createAttemptParams())
            : runAgentHarnessLifecycleFinalization(
                harness,
                createFinalizationParams(),
                async () => ({
                  assistant: createFinalAssistant(),
                }),
              ),
        );
        await flushDiagnosticEvents();
      } finally {
        diagnostics.unsubscribe();
        clearRuntimeConfigSnapshot();
      }

      expect(diagnostics.events).toHaveLength(1);
      expect(diagnostics.events[0]?.privateData.messageContent).toEqual({
        userPrompt: "hello",
        finalResponse: "done",
      });
    },
  );

  it("excludes commentary-phase text from the captured finalization answer", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    const params = createFinalizationParams();
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      pluginId: "codex-plugin",
      supports: () => ({ supported: true }),
      runAttempt: async () => createAttemptResult(),
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await runAgentHarnessLifecycleFinalization(harness, params, async () => ({
        assistant: {
          ...createFinalAssistant(),
          content: [
            {
              type: "text",
              text: "Checking intermediate details.",
              textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
            },
            {
              type: "text",
              text: "Task complete.",
              textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
            },
          ],
        },
      }));
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
      clearRuntimeConfigSnapshot();
    }

    const completed = diagnostics.events.find(
      ({ event }) => event.type === "harness.run.completed",
    );
    expect(completed?.privateData.harnessContent).toMatchObject({
      finalResponse: "Task complete.",
    });
  });

  it("captures only the canonical final answer, not pre-tool commentary", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    const finalAssistant = {
      ...createFinalAssistant(),
      content: [{ type: "text" as const, text: "final answer" }],
    };
    const result = {
      ...createAttemptResult(),
      assistantTexts: ["I will use a tool first.", "final answer"],
      currentAttemptAssistant: finalAssistant,
      currentAttemptCompletedAssistant: finalAssistant,
    };
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => result,
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await runAgentHarnessLifecycleAttempt(harness, createAttemptParams());
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
      clearRuntimeConfigSnapshot();
    }

    expect(diagnostics.events[1]?.privateData.harnessContent).toEqual({
      finalResponse: "final answer",
    });
  });

  it("captures the raw final answer rather than the delivery-sanitized projection", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    const finalAssistant = {
      ...createFinalAssistant(),
      content: [{ type: "text" as const, text: "Hello.\n\nHello." }],
    };
    const result = {
      ...createAttemptResult(),
      assistantTexts: ["Hello.\n\nHello."],
      currentAttemptAssistant: finalAssistant,
      currentAttemptCompletedAssistant: finalAssistant,
    };
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => result,
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await runAgentHarnessLifecycleAttempt(harness, createAttemptParams());
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
      clearRuntimeConfigSnapshot();
    }

    expect(diagnostics.events[1]?.privateData.harnessContent).toEqual({
      finalResponse: "Hello.\n\nHello.",
    });
  });

  it("does not capture pre-tool commentary as a final answer", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    const result = {
      ...createAttemptResult(),
      assistantTexts: ["I will use a tool first."],
      currentAttemptAssistant: undefined,
    };
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => result,
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await runAgentHarnessLifecycleAttempt(harness, createAttemptParams());
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
      clearRuntimeConfigSnapshot();
    }

    expect(diagnostics.events[1]?.privateData.harnessContent).toBeUndefined();
  });

  it("bounds captured harness prompts and responses before diagnostic dispatch", async () => {
    setRuntimeConfigSnapshot({ diagnostics: { otel: { enabled: true, captureContent: true } } });
    // Mirrors the private per-field budget in src/infra/diagnostic-content.ts; the
    // production constant stays unexported because only tests would consume it.
    const MAX_DIAGNOSTIC_CONTENT_CHARS = 128 * 1024;
    const oversizedContent = `${"x".repeat(MAX_DIAGNOSTIC_CONTENT_CHARS - 1)}🚀tail`;
    const params = { ...createAttemptParams(), prompt: oversizedContent };
    const result = {
      ...createAttemptResult(),
      assistantTexts: [oversizedContent],
      currentAttemptAssistant: {
        ...createFinalAssistant(),
        content: [{ type: "text" as const, text: oversizedContent }],
      },
    };
    const harness: AgentHarness = {
      id: "codex",
      label: "Codex",
      supports: () => ({ supported: true }),
      runAttempt: async () => result,
    };
    const diagnostics = captureDiagnosticEvents();
    try {
      await runAgentHarnessLifecycleAttempt(harness, params);
      await flushDiagnosticEvents();
    } finally {
      diagnostics.unsubscribe();
    }

    const startedPrompt = diagnostics.events[0]?.privateData.harnessContent?.userPrompt;
    const completedResponse = diagnostics.events[1]?.privateData.harnessContent?.finalResponse;
    expect(startedPrompt?.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
    expect(completedResponse?.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CONTENT_CHARS);
    expect(startedPrompt?.charCodeAt((startedPrompt?.length ?? 0) - 1)).not.toBe(0xd83d);
    expect(completedResponse?.charCodeAt((completedResponse?.length ?? 0) - 1)).not.toBe(0xd83d);
  });
});

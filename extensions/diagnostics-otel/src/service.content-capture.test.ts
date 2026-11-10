import {
  emitTrustedDiagnosticEventWithPrivateData as emit,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test } from "vitest";
import { installRealOtelSdkTestHarness } from "./service.real-sdk.test-support.js";
import {
  CHILD_SPAN_ID,
  createTestTrace,
  MODEL_CALL_FIXTURE,
  startOtelService,
} from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness({ replaceTraceProvider: true });
const content = { userPrompt: "run the task", finalResponse: "task complete" };
const run = {
  runId: "run-capture",
  trace: createTestTrace(CHILD_SPAN_ID),
};
const harness = { ...run, harnessId: "claude-cli" };

test("redacts captured strings before JSON escaping", async () => {
  const { service, ctx } = await startOtelService({ traces: true, captureContent: true });
  const canary = "DUMMY0NOT0A0REAL0SECRET0QZ7";
  const text = `notes\npassword=${canary}\nAPI_KEY=${canary}\ttoken=${canary}\r\nsecret=${canary}`;
  emit(
    { type: "model.call.completed", ...MODEL_CALL_FIXTURE, durationMs: 10 },
    {
      modelContent: {
        inputMessages: [{ role: "user", content: text }],
        outputMessages: [{ role: "assistant", content: text }],
        toolDefinitions: [{ name: "example", description: text }],
      },
    },
  );
  emit(
    {
      type: "tool.execution.completed",
      ...run,
      toolName: "example",
      toolCallId: "tool-capture",
      durationMs: 10,
    },
    { toolContent: { toolInput: { command: text }, toolOutput: { result: text } } },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);
  for (const [name, keys] of [
    [
      "openclaw.model.call",
      [
        "gen_ai.input.messages",
        "input.value",
        "gen_ai.output.messages",
        "output.value",
        "gen_ai.tool.definitions",
        "openclaw.content.input_messages",
        "openclaw.content.output_messages",
        "openclaw.content.tool_definitions",
      ],
    ],
    [
      "openclaw.tool.execution",
      [
        "gen_ai.tool.call.arguments",
        "gen_ai.tool.call.result",
        "openclaw.content.tool_input",
        "openclaw.content.tool_output",
      ],
    ],
  ] as const) {
    const attributes = sdk.exporter
      .getFinishedSpans()
      .find((span) => span.name === name)?.attributes;
    for (const key of keys) {
      const value = attributes?.[key];
      expect(value, key).toBeTypeOf("string");
      expect(value, key).toContain("notes");
      expect(value, key).not.toContain(canary);
      expect(() => JSON.parse(String(value)), key).not.toThrow();
    }
  }
});

test.each([
  ["message", true, false],
  ["message", false, false],
  ["run", true, false],
  ["run", false, false],
  ["harness", true, true],
  ["harness", false, true],
  ["harness", true, false],
  ["harness-error", true, false],
] as const)(
  "exports %s content with capture=%s, startup prompt=%s",
  async (kind, captureContent, startupPrompt) => {
    const { service, ctx } = await startOtelService({ traces: true, captureContent });
    let name: string;
    if (kind === "message") {
      emit(
        {
          type: "message.processed",
          channel: "webchat",
          durationMs: 5,
          outcome: "completed",
        },
        { messageContent: content },
      );
      name = "openclaw.message.processed";
    } else if (kind === "run") {
      emit({ type: "run.started", ...run }, undefined);
      emit(
        { type: "run.completed", ...run, durationMs: 60, outcome: "completed" },
        { messageContent: content },
      );
      name = "openclaw.run";
    } else {
      emit(
        { type: "harness.run.started", ...harness },
        startupPrompt ? { harnessContent: { userPrompt: content.userPrompt } } : undefined,
      );
      const privateData = {
        harnessContent: startupPrompt ? { finalResponse: content.finalResponse } : content,
      };
      const terminal =
        kind === "harness-error"
          ? ({ type: "harness.run.error", phase: "cleanup", errorCategory: "other" } as const)
          : ({ type: "harness.run.completed", outcome: "completed" } as const);
      emit({ ...harness, ...terminal, durationMs: 100 }, privateData);
      name = "openclaw.harness.run";
    }
    await waitForDiagnosticEventsDrained();
    await service.stop?.(ctx);
    const attributes = sdk.exporter
      .getFinishedSpans()
      .find((span) => span.name === name)?.attributes;
    if (captureContent) {
      expect(attributes).toMatchObject({
        "input.value": content.userPrompt,
        "output.value": content.finalResponse,
      });
    } else {
      expect(Object.hasOwn(attributes ?? {}, "input.value")).toBe(false);
      expect(Object.hasOwn(attributes ?? {}, "output.value")).toBe(false);
    }
  },
);

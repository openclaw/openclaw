import { expect, it } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/index.js";
import { sanitizeTranscriptMessage } from "./transcript-sanitize.js";

it("preserves tool output across trajectory, delivery, and guarded storage", async () => {
  const secret = "sk-or-v1-abcdef0123456789";
  const output = `OPENROUTER_API_KEY=${secret}\n${"src/example.ts: build completed successfully\n".repeat(10)}`;
  const trajectoryResults: unknown[] = [];
  const deliveryResults: unknown[] = [];
  let terminalResult: unknown;
  const sm = SessionManager.inMemory();
  installSessionToolResultGuard(sm, {
    transformMessageForPersistence: sanitizeTranscriptMessage,
  });
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "tool-output-fidelity",
    trajectoryRecorder: {
      recordEvent: (type, event) => {
        if (type === "tool.result") {
          trajectoryResults.push(event?.result);
        }
      },
      flush: async () => {},
    },
    onAgentToolResult: (event) => {
      deliveryResults.push(event.result);
    },
  });
  const result = {
    content: [
      { type: "text" as const, text: output },
      { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" },
    ],
    details: { status: "completed", aggregated: output, credentials: { apiKey: secret } },
  };
  const callId = "call-1";
  const expectedResult = {
    content: [
      { type: "text", text: output },
      { type: "image", mimeType: "image/png", bytes: 5, omitted: true },
    ],
    details: { status: "completed", aggregated: output, credentials: { apiKey: secret } },
  };
  const expectedTrajectoryResult = {
    ...expectedResult,
    details: { status: "completed", credentials: { apiKey: secret } },
  };
  try {
    await subscription.runToolLifecycle({
      toolName: "exec",
      toolCallId: callId,
      args: {},
      execute: async (onImplementationStart) => {
        onImplementationStart();
        await sm.appendMessageAsync({
          role: "toolResult",
          toolCallId: callId,
          toolName: "exec",
          ...result,
          isError: false,
          timestamp: 0,
        });
        return result;
      },
      onTerminal: (terminal) => {
        terminalResult = terminal.readSanitizedResult();
      },
    });
    expect(trajectoryResults).toEqual([expectedTrajectoryResult]);
    expect(deliveryResults).toEqual([expectedResult]);
    expect(terminalResult).toEqual(expectedResult);
    const storedToolResults = sm
      .getEntries()
      .flatMap((entry) =>
        entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
      );
    expect(storedToolResults).toMatchObject([
      {
        role: "toolResult",
        toolCallId: callId,
        toolName: "exec",
        content: [
          { type: "text", text: output },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        details: expectedResult.details,
        isError: false,
        timestamp: 0,
      },
    ]);
    emit({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: callId,
      result,
      isError: false,
    });
    await subscription.waitForPendingEvents();
    expect(trajectoryResults).toEqual([expectedTrajectoryResult, expectedTrajectoryResult]);
    expect(deliveryResults).toEqual([expectedResult, expectedResult]);
  } finally {
    subscription.unsubscribe();
  }
});

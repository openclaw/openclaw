import { afterEach, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { sanitizeToolResult } from "./embedded-agent-tool-results.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { SessionManager } from "./sessions/index.js";
import { sanitizeTranscriptMessage } from "./transcript-sanitize.js";

afterEach(() => vi.restoreAllMocks());

it("preserves tool output across trajectory, delivery, and nested persistence", async () => {
  const secret = "sk-or-v1-abcdef0123456789";
  const output = `OPENROUTER_API_KEY=${secret}\n${"src/example.ts: build completed successfully\n".repeat(10)}`;
  const exposed: unknown[] = [];
  const sm = SessionManager.inMemory();
  installSessionToolResultGuard(sm, {
    transformMessageForPersistence: sanitizeTranscriptMessage,
  });
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "tool-output-fidelity",
    trajectoryRecorder: {
      recordEvent: (_type, event) => {
        exposed.push(event);
      },
      flush: async () => {},
    },
    onAgentToolResult: (event) => {
      exposed.push(event.result);
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
  try {
    await subscription.runToolLifecycle({
      toolName: "exec",
      toolCallId: callId,
      args: {},
      execute: async (onImplementationStart) => {
        onImplementationStart();
        sm.appendMessage({
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
        exposed.push(terminal.readSanitizedResult());
      },
    });
    emit({
      type: "tool_execution_end",
      toolName: "exec",
      toolCallId: callId,
      result,
      isError: false,
    });
    await subscription.waitForPendingEvents();
    expect(exposed.length).toBeGreaterThanOrEqual(5);
    expect(JSON.stringify(exposed)).toContain(secret);
    expect(JSON.stringify(sm.getEntries())).toContain(secret);
    expect(sanitizeToolResult(result)).toMatchObject({
      content: [{ type: "text" }, { type: "image", bytes: 5, omitted: true }],
      details: { credentials: { apiKey: secret } },
    });
  } finally {
    subscription.unsubscribe();
  }
});

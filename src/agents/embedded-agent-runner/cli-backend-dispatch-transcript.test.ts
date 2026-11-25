import { beforeEach, expect, it, vi } from "vitest";
import { createCliDispatchTranscriptRecorder } from "./cli-backend-dispatch-transcript.js";

const appendTranscriptMessage = vi.hoisted(() => vi.fn());

// mock-isolation: Inspect recorder output without opening or mutating a session database.
vi.mock("../../config/sessions/session-accessor.js", () => ({ appendTranscriptMessage }));

const appendedRecords = () =>
  appendTranscriptMessage.mock.calls.map((call) => ({
    scope: call[0] as Record<string, unknown>,
    message: (call[1] as { message: Record<string, unknown> }).message,
  }));

const scope = {
  sessionId: "recall-session",
  sessionKey: "agent:main:recall",
  agentId: "main",
  sessionFile: "sqlite://agents/main/recall-session",
  expectedLifecycleRevision: "revision-a",
  expectedWriterRunId: "run-transcript-test",
};
function createRecorder() {
  return createCliDispatchTranscriptRecorder({
    ...scope,
    runId: "run-transcript-test",
    prompt: "recall prompt",
    provider: "claude-cli",
    model: "claude-opus-4-8",
    senderIsOwner: true,
  });
}

const recallCall = { toolName: "memory_search", toolCallId: "call-1" };
const textContent = (text: string) => [{ type: "text", text }];
const assistantMessage = (text: string, stopReason: string) => ({
  role: "assistant",
  content: textContent(text),
  stopReason,
});
const recallContent = textContent('{"results":[{"id":"m1"}]}');
const recallDetails = { results: [{ id: "m1" }], debug: { backend: "builtin", hits: 1 } };
const messages = () => appendedRecords().map((record) => record.message);
const assistants = () => appendedRecords().filter((record) => record.message.role === "assistant");

beforeEach(() => {
  appendTranscriptMessage.mockReset();
  appendTranscriptMessage.mockResolvedValue({ appended: true, message: {}, messageId: "m" });
});

it.each(["wrapped", "bare-array"])("mirrors %s recall results and network taint", async (shape) => {
  const recorder = createRecorder();
  const details = shape === "wrapped" ? recallDetails : undefined;
  const result = shape === "wrapped" ? { content: recallContent, details } : recallContent;
  recorder.noteToolEvent({
    phase: "start",
    ...recallCall,
    args: { query: "wings" },
  });
  recorder.noteToolEvent({
    phase: "result",
    ...recallCall,
    result,
    isError: false,
    resultContentSource: shape === "wrapped" ? "network" : undefined,
  });
  await recorder.finalize("Lemon pepper.");

  expect(appendedRecords()[0]?.scope).toMatchObject(scope);
  expect(messages()).toMatchObject([
    {
      role: "user",
      content: textContent("recall prompt"),
      __openclaw: { senderIsOwner: true },
    },
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call-1",
          name: "memory_search",
          arguments: { query: "wings" },
        },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      ...recallCall,
      content: recallContent,
      details,
      isError: false,
    },
    assistantMessage("Lemon pepper.", "stop"),
  ]);
  if (shape === "wrapped") {
    expect(messages()[2]?.["__openclaw"]).toEqual({ resultContentSource: "network" });
    expect(messages()[3]?.["__openclaw"]).toEqual({ turnTainted: true });
  }
});

it("survives a failed append and publishes later tool records before finalization", async () => {
  appendTranscriptMessage.mockRejectedValueOnce(new Error("store unavailable"));
  const recorder = createRecorder();
  recorder.noteToolEvent({
    phase: "result",
    toolName: "memory_search",
    result: { content: [], details: { status: "unavailable", error: "backend offline" } },
    isError: true,
  });
  await vi.waitFor(() => {
    expect(messages().find((message) => message.role === "toolResult")).toMatchObject({
      toolName: "memory_search",
      details: { status: "unavailable", error: "backend offline" },
      isError: true,
    });
  });
  await expect(recorder.finalize("text")).resolves.toBeUndefined();
  expect(messages().at(-1)).toMatchObject(assistantMessage("text", "stop"));
});

it.each([
  { finalText: undefined, count: 1 },
  { finalText: "full final answer", count: 2 },
])("flushes then finalizes $finalText without duplicates", async ({ finalText, count }) => {
  const recorder = createRecorder();
  recorder.noteAssistantText("partial before kill");
  recorder.flushAssistantSnapshot();
  await vi.waitFor(() => expect(assistants()).toHaveLength(1));
  await recorder.finalize(finalText);
  expect(assistants()).toHaveLength(count);
  expect(assistants()[0]?.message).toMatchObject(
    assistantMessage("partial before kill", "aborted"),
  );
  if (finalText) {
    expect(assistants()[1]?.message).toMatchObject(assistantMessage(finalText, "stop"));
  }
});

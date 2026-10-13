import fs from "node:fs/promises";
import path from "node:path";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeTextToolResult } from "../../test/helpers/text-tool-result.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import { createOpenClawReadTool } from "./agent-tools.read.js";
import { buildExecForegroundResult } from "./bash-tools.exec-support.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { createReadTool } from "./sessions/tools/read.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { sanitizeTranscriptMessage } from "./transcript-sanitize.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type AppendMessage = Parameters<SessionManager["appendMessageAsync"]>[0];
const asAppendMessage = (message: unknown) => message as AppendMessage;
const call = (id = "call_1", name = "read") =>
  makeAgentAssistantMessage({
    content: [{ type: "toolCall", id, name, arguments: {} }],
    stopReason: "toolUse",
  });
const assistant = (text: string) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }] });
const result = (text: string, toolName = "read") =>
  makeTextToolResult("call_1", toolName, text, false, 1);

function setup(options?: Parameters<typeof installSessionToolResultGuard>[1]) {
  const sm = SessionManager.inMemory();
  return { sm, guard: installSessionToolResultGuard(sm, options) };
}
function messages(sm: SessionManager): AgentMessage[] {
  return sm.getEntries().flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}
function roles(sm: SessionManager, expected: AgentMessage["role"][]) {
  const persisted = messages(sm);
  expect(persisted.map((message) => message.role)).toEqual(expected);
  return persisted;
}
function resultText(sm: SessionManager) {
  const message = messages(sm).find((item) => item.role === "toolResult");
  const text = message?.content.find((block) => block.type === "text")?.text;
  return text;
}

describe("installSessionToolResultGuard", () => {
  it("keeps the exec retention-loss disclosure through the session result cap", async () => {
    const { sm } = setup({ maxToolResultChars: 4_000 });
    const output = buildExecForegroundResult({
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 1,
        aggregated: "x".repeat(80_000),
        timedOut: false,
      },
      aggregateOutputDropped: true,
    });
    const content = output.content[0];
    if (!content || content.type !== "text") {
      throw new Error("expected text result");
    }
    await sm.appendMessageAsync(call());
    await sm.appendMessageAsync(result(content.text));
    expect(resultText(sm)).toMatch(
      /^\[earlier output was discarded at the retention cap and cannot be recovered\]/,
    );
    expect(resultText(sm)).toMatch(/\[\.\.\. \d+ more characters truncated/);
  });

  it("preserves ordering with multiple tool calls and partial results", async () => {
    const { sm, guard } = setup();
    await sm.appendMessageAsync(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_a", name: "one", arguments: {} },
          { type: "toolUse", id: "call_b", name: "two", arguments: {} },
        ],
      }),
    );
    await sm.appendMessageAsync(
      asAppendMessage({
        role: "toolResult",
        toolUseId: "call_a",
        content: [{ type: "text", text: "a" }],
        isError: false,
      }),
    );
    await sm.appendMessageAsync(assistant("after tools"));
    const persisted = roles(sm, ["assistant", "toolResult", "toolResult", "assistant"]);
    expect(persisted[2]).toMatchObject({ toolCallId: "call_b", isError: true });
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("does not synthesize older pending results before a new assistant tool-call turn", async () => {
    const { sm, guard } = setup();
    await sm.appendMessageAsync(call());
    await sm.appendMessageAsync(call("call_2", "exec"));
    await sm.appendMessageAsync(result("real output"));
    const persisted = roles(sm, ["assistant", "assistant", "toolResult"]);
    expect(persisted[2]).toMatchObject({ toolCallId: "call_1", isError: false });
    expect(JSON.stringify(persisted)).not.toContain("missing tool result");
    expect(guard.getPendingIds()).toEqual(["call_2"]);
  });

  it("repairs pending calls only after the streamed response changes", async () => {
    const { sm, guard } = setup({ missingToolResultText: "aborted" });
    await sm.appendMessageAsync({ ...call(), turnId: "turn_1" });
    await sm.appendMessageAsync({
      ...assistant("Checking now."),
      turnId: "turn_1",
      responseId: "resp_1",
      stopReason: "toolUse",
    });
    roles(sm, ["assistant", "assistant"]);
    expect(guard.getPendingIds()).toEqual(["call_1"]);
    await sm.appendMessageAsync({ ...assistant("Done."), responseId: "resp_2" });
    roles(sm, ["assistant", "assistant", "toolResult", "assistant"]);
    expect(resultText(sm)).toBe("aborted");
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("clears disabled-synthesis pending state across replacement and dropped calls", async () => {
    const { sm, guard } = setup({ allowSyntheticToolResults: false, allowedToolNames: ["read"] });
    await sm.appendMessageAsync(call());
    await sm.appendMessageAsync(call("call_2"));
    expect(guard.getPendingIds()).toEqual(["call_2"]);
    await sm.appendMessageAsync(
      asAppendMessage({
        role: "assistant",
        content: [
          { type: "toolCall", id: "unknown", name: "write", arguments: {} },
          { type: "toolCall", id: "missing-input", name: "read" },
          { type: "toolCall", id: "bad-name", name: "invalid name", arguments: {} },
        ],
      }),
    );
    roles(sm, ["assistant", "assistant"]);
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("blocks user persistence and reports the blocked message", async () => {
    const blocked: AgentMessage[] = [];
    const { sm } = setup({
      beforeMessageWriteHook: () => ({ block: true }),
      onUserMessageBlocked: (message) => {
        blocked.push(message);
      },
    });
    await sm.appendMessageAsync(makeUserMessage("hidden", 1));
    expect(messages(sm)).toEqual([]);
    expect(blocked).toMatchObject([{ role: "user", content: "hidden" }]);
  });

  it("consumes runtime attribution when a hook blocks the marker before the next user", async () => {
    let writes = 0;
    const { sm, guard } = setup({
      beforeMessageWriteHook: () => (writes++ === 0 ? { block: true } : undefined),
    });
    guard.setNextUserMessagePersistence("runtime");
    await sm.appendMessageAsync(makeUserMessage("runtime-only marker", 1));
    await sm.appendMessageAsync(makeUserMessage("actual user", 2));

    expect(messages(sm)).toEqual([{ role: "user", content: "actual user", timestamp: 2 }]);
  });

  it("preserves correlation IDs while backfilling names through persistence transforms", async () => {
    const { sm, guard } = setup({
      beforeMessageWriteHook: ({ message }) => ({
        message: sanitizeTranscriptMessage(message),
      }),
    });
    const id = "call_fixture|fc-" + "a".repeat(24);
    await sm.appendMessageAsync(asAppendMessage({ role: "assistant", content: call(id).content }));
    await sm.appendMessageAsync({ ...result("observed", "   "), toolCallId: id });
    await guard.flushPendingToolResultsAsync();
    expect(roles(sm, ["assistant", "toolResult"])[1]).toMatchObject({
      toolName: "read",
      toolCallId: id,
      isError: false,
    });
    expect(guard.getPendingIds()).toEqual([]);
  });

  it("repairs blocked results with canonical synthetic IDs after transforms", async () => {
    const { sm, guard } = setup({
      transformMessageForPersistence: (message) => {
        if (message.role === "assistant") {
          return {
            ...message,
            content: [{ type: "toolCall", id: "p:call_1", name: "read", arguments: {} }],
          };
        }
        return message.role === "toolResult"
          ? { ...message, toolCallId: "p:" + message.toolCallId }
          : message;
      },
      beforeMessageWriteHook: ({ message }) =>
        message.role === "toolResult"
          ? !message.isError
            ? { block: true }
            : { message: { ...message, content: [{ type: "text", text: "safe failure" }] } }
          : undefined,
    });
    await sm.appendMessageAsync(call());
    expect(
      await sm.appendMessageAsync({ ...result("blocked"), toolCallId: "p:call_1" }),
    ).toBeUndefined();
    expect(guard.getPendingIds()).toEqual(["p:call_1"]);
    await guard.flushPendingToolResultsAsync();
    expect(roles(sm, ["assistant", "toolResult"])[1]).toMatchObject({
      toolCallId: "p:call_1",
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "safe failure" }],
    });
  });

  it.each([
    ["source.ts", "API_TOKEN = computeToken()\n"],
    [
      ".env.production",
      "API_TOKEN=fixture-token-1234567890\nOPENAI_API_KEY=sk-proj-fixture1234567890\n",
    ],
  ])("preserves %s read bytes in model context and transcript", async (fileName, text) => {
    const workspace = tempDirs.make("tool-result-fidelity-");
    await fs.writeFile(path.join(workspace, fileName), text);
    const read = createOpenClawReadTool(createReadTool(workspace));
    const output = await read.execute("call_1", { path: fileName });
    const sm = guardSessionManager(SessionManager.inMemory(), {
      config: { logging: { redactPatterns: ["fixture-token-[a-z0-9]+"] } },
    });
    await sm.appendMessageAsync(call());
    await sm.appendMessageAsync({
      ...result(""),
      content: output.content,
      details: output.details,
    });
    expect(output.content).toEqual([{ type: "text", text }]);
    expect(resultText(sm)).toBe(text);
    const modelResult = sm
      .buildSessionContext()
      .messages.find((message) => message.role === "toolResult");
    expect(modelResult?.content).toEqual([{ type: "text", text }]);
  });

  it("applies before_message_write to synthetic tool-result flushes", async () => {
    const { sm, guard } = setup({
      beforeMessageWriteHook: ({ message }) =>
        message.role === "toolResult" ? { block: true } : undefined,
    });
    await sm.appendMessageAsync(call());
    await guard.flushPendingToolResultsAsync();
    roles(sm, ["assistant"]);
  });

  it("suppresses only the next persisted user message when requested", async () => {
    const { sm } = setup({ suppressNextUserMessagePersistence: true });
    await sm.appendMessageAsync(makeUserMessage("first", 1));
    await sm.appendMessageAsync(makeUserMessage("second", 2));
    expect(messages(sm)).toMatchObject([{ role: "user", content: "second" }]);
  });

  it("suppresses transcript-only assistants while retaining tool calls", async () => {
    const { sm } = setup({ suppressTranscriptOnlyAssistantPersistence: true });
    await sm.appendMessageAsync(
      asAppendMessage({ role: "assistant", content: "private room-event note" }),
    );
    await sm.appendMessageAsync(call("call_1", "message"));
    expect(messages(sm)).toMatchObject([
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_1" }],
      },
    ]);
  });
});

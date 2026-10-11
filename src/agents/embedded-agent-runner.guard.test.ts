import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileBackedSessionManagerForTest } from "../../test/helpers/session-manager-file-fixture.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { attachRuntimeUserTurnTranscriptContext } from "../sessions/user-turn-transcript-runtime-context.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../sessions/user-turn-transcript.test-support.js";
import { createDeferredCore } from "../shared/deferred.js";
import { flushPendingToolResultsAfterIdle } from "./embedded-agent-runner/wait-for-idle-before-flush.js";
import { runAgentHarnessBeforeMessageWriteHook } from "./harness/hook-helpers.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { textToolResult } from "./test-helpers/sparse-transcript.test-support.js";

function installWriteHook(handler: (...args: unknown[]) => unknown) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_message_write", handler }]),
  );
}

afterEach(() => {
  resetGlobalHookRunner();
  vi.useRealTimers();
});

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "n", arguments: {} }],
  } as AgentMessage;
}

function appender(sm: ReturnType<typeof guardSessionManager>) {
  return sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
}

function getMessages(sm: ReturnType<typeof guardSessionManager>): AgentMessage[] {
  return sm
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AgentMessage }).message);
}

describe("guardSessionManager integration", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps real toolResult pending across delivery-mirror assistant messages", () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = appender(sm);

    appendMessage(assistantToolCall("call_1"));
    appendMessage({
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "display copy" }],
    } as AgentMessage);
    appendMessage(textToolResult("call_1", "n", "real output", { isError: false }) as AgentMessage);

    const messages = getMessages(sm);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "assistant", "toolResult"]);
    expect(messages[1]).toMatchObject({ model: "delivery-mirror" });
    expect(messages[2]).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "real output" }],
    });
    expect(JSON.stringify(messages)).not.toContain("missing tool result");
  });

  it("correlates nested user persists with their exact runtime messages", () => {
    const outerRuntime = { role: "user", content: "outer" } as AgentMessage;
    const nestedRuntime = { role: "user", content: "nested" } as AgentMessage;
    const correlations: Array<{ persisted: AgentMessage; runtime?: AgentMessage }> = [];
    let nested = false;
    installWriteHook((...args: unknown[]) => {
      const { message } = args[0] as { message: AgentMessage };
      if (!nested && message.role === "user" && message.content === "outer") {
        nested = true;
        appendMessage(nestedRuntime);
      }
      return undefined;
    });
    const sm = guardSessionManager(SessionManager.inMemory(), {
      onUserMessagePersisted: (persisted, runtime) => {
        correlations.push({ persisted, runtime });
      },
    });
    const appendMessage = appender(sm);

    appendMessage(outerRuntime);

    expect(correlations).toEqual([
      { persisted: nestedRuntime, runtime: nestedRuntime },
      { persisted: outerRuntime, runtime: outerRuntime },
    ]);
  });

  it("correlates a suppressed user persist with its exact runtime message", () => {
    const runtimeMessage = { role: "user", content: "already durable" } as AgentMessage;
    const suppressed: Array<{ persisted: AgentMessage; runtime?: AgentMessage }> = [];
    const sm = guardSessionManager(SessionManager.inMemory(), {
      preparedUserTurnMessage: {
        role: "user",
        content: "already durable",
        timestamp: 1,
        __openclaw: { senderName: "Alice" },
      } as PersistedUserTurnMessage,
      suppressNextUserMessagePersistence: true,
      onUserMessagePersistenceSuppressed: (persisted, runtime) => {
        suppressed.push({ persisted, runtime });
      },
    });

    const appendMessage = appender(sm);
    appendMessage(runtimeMessage);

    expect(sm.getEntries()).toEqual([]);
    expect(suppressed).toEqual([
      {
        persisted: expect.objectContaining({
          content: "already durable",
          __openclaw: { senderName: "Alice" },
        }),
        runtime: runtimeMessage,
      },
    ]);
  });

  it.each(["user", "assistant"] as const)(
    "sender provenance repair preserves runtime hook %s rewrites and display redaction",
    (role) => {
      const prepared: PersistedUserTurnMessage = {
        role: "user",
        content: "private",
        timestamp: 1,
        __openclaw: {
          senderId: "person",
          senderIdentity: { type: "profile", id: "person" },
          senderIsOwner: true,
          replyToId: "private-reply",
          replyToPreview: { text: "private" },
          transport: { messageId: "private" },
          media: [{ path: "private" }],
          mediaImageLayout: { slots: [] },
          lateMedia: true,
        },
      };
      const replacement =
        role === "user"
          ? { role, content: "redacted", timestamp: 2, __openclaw: { hookOwned: true } }
          : makeAgentAssistantMessage({ content: [{ type: "text", text: "rewritten" }] });
      installWriteHook(() => ({ message: replacement }));
      // Generic harness hooks only constrain sender provenance; runtime preparation
      // separately protects operational fields, not editable reply/media display.
      expect(runAgentHarnessBeforeMessageWriteHook({ message: prepared })).toEqual(replacement);
      const sm = guardSessionManager(SessionManager.inMemory(), {
        preparedUserTurnMessage: prepared,
      });
      sm.appendMessage({ role: "user", content: "runtime", timestamp: 3 });
      expect(getMessages(sm)).toEqual([
        role === "user"
          ? { ...replacement, __openclaw: { hookOwned: true, senderIsOwner: true } }
          : replacement,
      ]);
    },
  );

  it.each(["retain", "in-place", "forge"] as const)(
    "sender provenance survives only unchanged queued hook evidence: %s",
    (mode) => {
      installWriteHook((event) => {
        const message = (event as { message: PersistedUserTurnMessage }).message;
        const metadata = message["__openclaw"]!;
        if (mode === "in-place") {
          (metadata.senderIdentity as { id: string }).id = "forged";
        }
        if (mode === "forge") {
          metadata.senderIdentity = { type: "profile", id: "forged" };
        }
        metadata.senderIsOwner = false;
      });
      const identity = { type: "profile", id: "author" };
      const recorder = createUserTurnTranscriptRecorder({
        message: {
          role: "user",
          content: "queued",
          timestamp: 1,
          __openclaw: {
            senderId: "author",
            senderIsOwner: true,
            ...(mode === "forge" ? {} : { senderIdentity: identity }),
          },
        },
        target: createTestUserTurnTranscriptTarget(),
      });
      const sm = guardSessionManager(SessionManager.inMemory());
      sm.appendMessage(
        attachRuntimeUserTurnTranscriptContext(
          { role: "user", content: "runtime", timestamp: 2 },
          { message: recorder.message!, recorder },
        ),
      );
      expect(getMessages(sm)[0]).toMatchObject({
        __openclaw: { senderId: "author", senderIsOwner: true },
      });
      expect(
        (getMessages(sm)[0] as PersistedUserTurnMessage)["__openclaw"]?.senderIdentity,
      ).toEqual(mode === "retain" ? { type: "profile", id: "author" } : undefined);
      expect(recorder.hasPersisted()).toBe(true);
    },
  );

  it("commits queued group sender metadata to JSONL and completes its recorder", () => {
    const dir = tempDirs.make("openclaw-queued-group-turn-");
    const sessionManager = createFileBackedSessionManagerForTest(dir, dir);
    const sessionFile = expectDefined(
      sessionManager.getSessionFile(),
      "expected file-backed session manager",
    );
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "visible group prompt",
        sender: { id: "user-42", name: "Ada", username: "ada42" },
      },
      target: createTestUserTurnTranscriptTarget(),
    });
    const preparedMessage = expectDefined(recorder.message, "expected prepared group turn");
    const sm = guardSessionManager(sessionManager, {
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
      {
        role: "user",
        content: [{ type: "text", text: "runtime group prompt" }],
        timestamp: 456,
      },
      { message: preparedMessage, recorder },
    );

    sm.appendMessage(runtimeMessage);
    sm.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "acknowledged" }],
      }),
    );

    const entries = readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: AgentMessage });
    expect(entries.find((entry) => entry.message?.role === "user")?.message).toMatchObject({
      role: "user",
      content: "visible group prompt",
      __openclaw: {
        senderId: "user-42",
        senderName: "Ada",
        senderUsername: "ada42",
      },
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    expect(recorder.hasPersisted()).toBe(true);
  });

  it("marks the exact queued recorder blocked when a write hook suppresses its user message", () => {
    installWriteHook(() => ({ block: true }));
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "queued prompt" },
      target: createTestUserTurnTranscriptTarget(),
    });
    const preparedMessage = expectDefined(recorder.message, "expected prepared queued turn");
    const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
      makeUserMessage("runtime queued prompt", 456),
      { message: preparedMessage, recorder },
    );
    const sm = guardSessionManager(SessionManager.inMemory());

    sm.appendMessage(runtimeMessage);

    expect(getMessages(sm)).toEqual([]);
    expect(recorder.isBlocked()).toBe(true);
  });

  it("does not consume prepared user persistence for before-agent-run blocked messages", () => {
    const prepared = {
      role: "user",
      content: "visible prompt",
      timestamp: 123,
      MediaPath: "/tmp/a.png",
      MediaPaths: ["/tmp/a.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    } as PersistedUserTurnMessage;
    const sm = guardSessionManager(SessionManager.inMemory(), {
      preparedUserTurnMessage: structuredClone(prepared),
    });
    const appendMessage = appender(sm);

    appendMessage({
      role: "user",
      content: [{ type: "text", text: "blocked" }],
      timestamp: 124,
      __openclaw: { beforeAgentRunBlocked: { blockedBy: "test", blockedAt: 123 } },
    } as AgentMessage);
    appendMessage({ role: "user", content: "runtime prompt" } as AgentMessage);
    appendMessage({ role: "user", content: "follow-up" } as AgentMessage);

    const messages = getMessages(sm);

    expect(messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "blocked" }],
      __openclaw: { beforeAgentRunBlocked: { blockedBy: "test", blockedAt: 123 } },
    });
    expect(messages[0]).not.toHaveProperty("MediaPath");
    expect(messages[2]).toEqual({ role: "user", content: "follow-up" });
    expect(messages[1]).toMatchObject(prepared);
  });

  it("skips plugin hooks while preserving every persisted transcript content field", () => {
    installWriteHook(() => ({
      message: makeAgentAssistantMessage({
        content: [{ type: "text", text: "changed by hook" }],
      }),
    }));

    const cfg = {
      logging: {
        redactPatterns: [String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`],
      },
    } satisfies OpenClawConfig;
    const sm = guardSessionManager(SessionManager.inMemory(), {
      config: cfg,
      skipBeforeMessageWriteHooks: true,
    });
    const appendMessage = appender(sm);

    appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the email is peter@dc.io", thinkingSignature: "sig" },
        { type: "text", text: "contact peter@dc.io" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/peter@dc.io" } },
      ],
      stopReason: "toolUse",
    } as AgentMessage);
    appendMessage(
      textToolResult("call_1", "read", "peter@dc.io\n", { isError: false }) as AgentMessage,
    );

    const messages = getMessages(sm);

    expect(messages).toMatchObject([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "the email is peter@dc.io", thinkingSignature: "sig" },
          { type: "text", text: "contact peter@dc.io" },
          { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/peter@dc.io" } },
        ],
      },
      { role: "toolResult", content: [{ type: "text", text: "peter@dc.io\n" }] },
    ]);
    expect(JSON.stringify(messages)).not.toContain("changed by hook");
  });
});

function idleToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
    stopReason: "toolUse",
  } as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text }],
    isError: false,
  } as AgentMessage;
}

describe("flushPendingToolResultsAfterIdle", () => {
  it("waits for idle so real tool results can land before flush", async () => {
    vi.useFakeTimers();
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = appender(sm);
    const idle = createDeferredCore();
    const agent = { waitForIdle: () => idle.promise };

    appendMessage(idleToolCall("call_retry_1"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(getMessages(sm).map((message) => message.role)).toEqual(["assistant"]);

    appendMessage(toolResult("call_retry_1", "command output here"));
    idle.resolve();
    await flushPromise;
    expect(vi.getTimerCount()).toBe(0);

    const messages = getMessages(sm);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(messages[1]).toMatchObject({
      isError: false,
      content: [{ type: "text", text: "command output here" }],
    });
  });

  it("flushes pending on cleanup timeout instead of leaving orphaned tool calls", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = appender(sm);
    vi.useFakeTimers();

    appendMessage(idleToolCall("call_orphan_2"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent: { waitForIdle: () => new Promise<void>(() => {}) },
      sessionManager: sm,
      timeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    await flushPromise;
    expect(vi.getTimerCount()).toBe(0);

    const messages = getMessages(sm);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect(messages[1]).toMatchObject({
      toolCallId: "call_orphan_2",
      isError: true,
    });

    appendMessage({
      role: "user",
      content: "still there?",
      timestamp: Date.now(),
    } as AgentMessage);
    expect(getMessages(sm).map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
    ]);
  });
});

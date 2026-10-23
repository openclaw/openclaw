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
import {
  attachRuntimePromptMediaFacts,
  readRuntimePromptMediaFacts,
} from "../media/media-facts.js";
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

const text = (value: string) => [{ type: "text" as const, text: value }];

function installWriteHook(handler: (...args: unknown[]) => unknown) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_message_write", handler }]),
  );
}

afterEach(() => {
  resetGlobalHookRunner();
  vi.useRealTimers();
});

function assistantToolCall(id: string, name = "n", stopReason?: "toolUse"): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    ...(stopReason ? { stopReason } : {}),
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

function createGuard(options?: Parameters<typeof guardSessionManager>[1]) {
  const sm = guardSessionManager(SessionManager.inMemory(), options);
  return { sm, appendMessage: appender(sm) };
}

function queuedRuntime(
  recorder: ReturnType<typeof createUserTurnTranscriptRecorder>,
  content: PersistedUserTurnMessage["content"],
  timestamp: number,
) {
  const runtime = { role: "user" as const, content, timestamp };
  return attachRuntimeUserTurnTranscriptContext(runtime, {
    message: expectDefined(recorder.message, "expected prepared queued turn"),
    recorder,
  });
}

describe("guardSessionManager integration", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("keeps real toolResult pending across delivery-mirror assistant messages", () => {
    const { sm, appendMessage } = createGuard();

    appendMessage(assistantToolCall("call_1"));
    appendMessage({
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: text("display copy"),
    } as AgentMessage);
    appendMessage(textToolResult("call_1", "n", "real output", { isError: false }) as AgentMessage);

    const messages = getMessages(sm);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "assistant", "toolResult"]);
    expect(messages[1]).toMatchObject({ model: "delivery-mirror" });
    expect(messages[2]).toMatchObject({
      isError: false,
      content: text("real output"),
    });
    expect(JSON.stringify(messages)).not.toContain("missing tool result");
  });

  it("correlates nested user persists with their exact runtime messages", () => {
    const outerRuntime = { role: "user", content: "outer" } as AgentMessage;
    const nestedRuntime = { role: "user", content: "nested" } as AgentMessage;
    const onUserMessagePersisted = vi.fn();
    let nested = false;
    installWriteHook((event) => {
      const { message } = event as { message: AgentMessage };
      if (!nested && message.role === "user" && message.content === "outer") {
        nested = true;
        appendMessage(nestedRuntime);
      }
      return undefined;
    });
    const { appendMessage } = createGuard({ onUserMessagePersisted });
    appendMessage(outerRuntime);

    expect(onUserMessagePersisted.mock.calls).toEqual([
      [nestedRuntime, nestedRuntime],
      [outerRuntime, outerRuntime],
    ]);
  });

  it("rebinds and retires user persistence callbacks without clearing a newer attempt", async () => {
    installWriteHook((event) => {
      const { message } = event as { message: AgentMessage };
      return message.role === "user" && message.content === "blocked" ? { block: true } : undefined;
    });
    const callbacks = () => ({
      onUserMessagePreparingForPersistence: vi.fn(),
      onUserMessagePersisted: vi.fn(),
      onUserMessagePersistenceSuppressed: vi.fn(),
      onUserMessageBlocked: vi.fn(),
      onMessagePersisted: vi.fn(),
    });
    const previous = callbacks();
    const current = callbacks();
    const { sm } = createGuard({ runId: "reused-run", ...previous });
    const clearPrevious = sm.clearTranscriptRunCallbacks;
    guardSessionManager(sm, { runId: "reused-run", ...current });
    clearPrevious?.();

    await sm.appendMessageAsync(makeUserMessage("persisted", 1));
    sm.setNextUserMessagePersistence?.("suppress");
    await sm.appendMessageAsync(makeUserMessage("suppressed", 2));
    await sm.appendMessageAsync(makeUserMessage("blocked", 3));
    sm.clearTranscriptRunCallbacks?.();
    await sm.appendMessageAsync(makeUserMessage("after cleanup", 4));

    for (const callback of Object.values(previous)) {
      expect(callback).not.toHaveBeenCalled();
    }
    expect(current.onUserMessagePreparingForPersistence).toHaveBeenCalledTimes(3);
    expect(current.onUserMessagePersisted).toHaveBeenCalledOnce();
    expect(current.onUserMessagePersistenceSuppressed).toHaveBeenCalledOnce();
    expect(current.onUserMessageBlocked).toHaveBeenCalledOnce();
    expect(current.onMessagePersisted).toHaveBeenCalledOnce();
    expect(getMessages(sm)).toEqual([
      makeUserMessage("persisted", 1),
      makeUserMessage("after cleanup", 4),
    ]);
  });

  it("keeps accepted writes bound to their run while the manager is rebound", async () => {
    const manager = SessionManager.inMemory();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const append = manager.appendMessageWithTranscriptAnchorAsync.bind(manager);
    vi.spyOn(manager, "appendMessageWithTranscriptAnchorAsync").mockImplementationOnce(
      async (...args) => {
        entered.resolve();
        await release.promise;
        return append(...args);
      },
    );
    const previous = { onMessagePersisted: vi.fn(), onUserMessagePersisted: vi.fn() };
    const current = { onMessagePersisted: vi.fn(), onUserMessagePersisted: vi.fn() };
    const sm = guardSessionManager(manager, {
      runId: "previous",
      privateCompletion: true,
      inputProvenance: { kind: "internal_system", sourceTool: "previous" },
      preparedUserTurnMessage: makeUserMessage("prepared previous turn", 2),
      prepareAssistantTranscriptMessage: (message) => ({
        ...message,
        openclawDelivery: { mediaUrls: ["./previous.png"] },
      }),
      ...previous,
    });
    const pending = sm.appendMessageAsync(makeAgentAssistantMessage({ content: text("previous") }));
    await entered.promise;
    const queued = sm.appendMessageAsync(makeUserMessage("queued previous turn", 2));
    const queuedAssistant = sm.appendMessageAsync(
      makeAgentAssistantMessage({ content: text("queued previous reply") }),
    );
    guardSessionManager(sm, {
      runId: "current",
      inputProvenance: { kind: "external_user" },
      preparedUserTurnMessage: makeUserMessage("prepared current turn", 3),
      ...current,
    });
    release.resolve();
    await Promise.all([pending, queued, queuedAssistant]);

    expect(getMessages(sm)).toMatchObject([
      { role: "assistant", display: false, __openclaw: { runId: "previous" } },
      {
        role: "user",
        content: "prepared previous turn",
        display: false,
        provenance: { kind: "internal_system", sourceTool: "previous" },
      },
      {
        role: "assistant",
        display: false,
        __openclaw: { runId: "previous" },
        openclawDelivery: { mediaUrls: ["./previous.png"] },
      },
    ]);
    expect(previous.onMessagePersisted).toHaveBeenCalledTimes(3);
    expect(previous.onUserMessagePersisted).toHaveBeenCalledOnce();
    expect(current.onMessagePersisted).not.toHaveBeenCalled();
    expect(current.onUserMessagePersisted).not.toHaveBeenCalled();
    await sm.appendMessageAsync(makeUserMessage("current turn", 3));
    expect(getMessages(sm)[3]).toMatchObject({
      content: "prepared current turn",
      provenance: { kind: "external_user" },
    });
    expect(getMessages(sm)[3]).not.toHaveProperty("display");
    expect(current.onMessagePersisted).toHaveBeenCalledOnce();
    expect(current.onUserMessagePersisted).toHaveBeenCalledOnce();
  });

  it("publishes a suppressed user envelope while preserving runtime media facts", () => {
    const media = [
      { path: "/workspace/current.mp4", contentType: "video/mp4", kind: "video" as const },
    ];
    const runtimeMessage = attachRuntimePromptMediaFacts(
      makeUserMessage("already durable", 2),
      structuredClone(media),
    );
    const prepared = {
      ...makeUserMessage("already durable", 1),
      __openclaw: { senderName: "Alice" },
    };
    const onUserMessagePersistenceSuppressed = vi.fn();
    const { sm, appendMessage } = createGuard({
      preparedUserTurnMessage: structuredClone(prepared),
      suppressNextUserMessagePersistence: true,
      onUserMessagePersistenceSuppressed,
    });

    appendMessage(runtimeMessage);

    expect(sm.getEntries()).toEqual([]);
    expect(runtimeMessage).toMatchObject(prepared);
    expect(readRuntimePromptMediaFacts(runtimeMessage)).toMatchObject(media);
    expect(JSON.stringify(runtimeMessage)).not.toContain("current.mp4");
    expect(onUserMessagePersistenceSuppressed).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining(prepared),
      runtimeMessage,
    );
  });

  it("keeps a retired prompt's persistence-mode setter bound to its own run", async () => {
    const { sm } = createGuard();
    const previousSetPersistence = sm.setNextUserMessagePersistence;
    guardSessionManager(sm, { suppressNextUserMessagePersistence: true });
    previousSetPersistence?.("normal");

    await sm.appendMessageAsync(makeUserMessage("already persisted current turn", 1));
    await sm.appendMessageAsync(makeUserMessage("next current turn", 2));

    expect(getMessages(sm)).toEqual([makeUserMessage("next current turn", 2)]);
  });

  it("keeps synthetic-result cleanup private after retiring callbacks", async () => {
    const onMessagePersisted = vi.fn();
    const { sm } = createGuard({
      runId: "private-run",
      privateCompletion: true,
      onMessagePersisted,
    });
    await sm.appendMessageAsync(
      makeAgentAssistantMessage({
        content: [{ type: "toolCall", id: "unfinished", name: "n", arguments: {} }],
        stopReason: "toolUse",
      }),
    );
    sm.clearTranscriptRunCallbacks?.();
    await sm.flushPendingToolResultsAsync?.();

    expect(getMessages(sm)[1]).toMatchObject({
      role: "toolResult",
      display: false,
      __openclaw: { runId: "private-run" },
    });
    expect(onMessagePersisted).toHaveBeenCalledOnce();
  });

  it.each(["user", "assistant"] as const)(
    "sender provenance repair preserves runtime hook %s rewrites and display redaction",
    (role) => {
      const prepared: PersistedUserTurnMessage = {
        ...makeUserMessage("private", 1),
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
          : makeAgentAssistantMessage({ content: text("rewritten") });
      installWriteHook(() => ({ message: replacement }));
      // Generic harness hooks only constrain sender provenance; runtime preparation
      // separately protects operational fields, not editable reply/media display.
      expect(runAgentHarnessBeforeMessageWriteHook({ message: prepared })).toEqual(replacement);
      const { sm, appendMessage } = createGuard({ preparedUserTurnMessage: prepared });
      appendMessage(makeUserMessage("runtime", 3));
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
          ...makeUserMessage("queued", 1),
          __openclaw: {
            senderId: "author",
            senderIsOwner: true,
            ...(mode === "forge" ? {} : { senderIdentity: identity }),
          },
        },
        target: createTestUserTurnTranscriptTarget(),
      });
      const { sm } = createGuard();
      sm.appendMessage(queuedRuntime(recorder, "runtime", 2));
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
    const sessionFile = expectDefined(sessionManager.getSessionFile(), "session file");
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "visible group prompt",
        sender: { id: "user-42", name: "Ada", username: "ada42" },
      },
      target: createTestUserTurnTranscriptTarget(),
    });
    const sm = guardSessionManager(sessionManager, {
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    const runtimeMessage = queuedRuntime(recorder, text("runtime group prompt"), 456);

    sm.appendMessage(runtimeMessage);
    sm.appendMessage(makeAgentAssistantMessage({ content: text("acknowledged") }));

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
    const runtimeMessage = queuedRuntime(recorder, "runtime queued prompt", 456);
    const { sm } = createGuard();

    sm.appendMessage(runtimeMessage);

    expect(getMessages(sm)).toEqual([]);
    expect(recorder.isBlocked()).toBe(true);
  });

  it("does not consume prepared user persistence for before-agent-run blocked messages", () => {
    const prepared = {
      ...makeUserMessage("visible prompt", 123),
      MediaPath: "/tmp/a.png",
      MediaPaths: ["/tmp/a.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    } as PersistedUserTurnMessage;
    const { sm, appendMessage } = createGuard({
      preparedUserTurnMessage: structuredClone(prepared),
    });
    const blocked = {
      role: "user",
      content: text("blocked"),
      timestamp: 124,
      __openclaw: { beforeAgentRunBlocked: { blockedBy: "test", blockedAt: 123 } },
    } as AgentMessage;
    appendMessage(structuredClone(blocked));
    appendMessage({ role: "user", content: "runtime prompt" } as AgentMessage);
    appendMessage({ role: "user", content: "follow-up" } as AgentMessage);

    const messages = getMessages(sm);

    expect(messages[0]).toMatchObject(blocked);
    expect(messages[0]).not.toHaveProperty("MediaPath");
    expect(messages[2]).toEqual({ role: "user", content: "follow-up" });
    expect(messages[1]).toMatchObject(prepared);
  });

  it("skips plugin hooks while preserving every persisted transcript content field", () => {
    installWriteHook(() => ({
      message: makeAgentAssistantMessage({ content: text("changed by hook") }),
    }));

    const { sm, appendMessage } = createGuard({
      config: {
        logging: {
          redactPatterns: [String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`],
        },
      } satisfies OpenClawConfig,
      skipBeforeMessageWriteHooks: true,
    });
    const assistantContent = [
      { type: "thinking", thinking: "the email is peter@dc.io", thinkingSignature: "sig" },
      { type: "text", text: "contact peter@dc.io" },
      { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/peter@dc.io" } },
    ];
    const assistant = {
      role: "assistant",
      content: assistantContent,
      stopReason: "toolUse",
    } as AgentMessage;
    appendMessage(structuredClone(assistant));
    appendMessage(
      textToolResult("call_1", "read", "peter@dc.io\n", { isError: false }) as AgentMessage,
    );

    const messages = getMessages(sm);

    expect(messages).toMatchObject([
      { role: "assistant", content: assistantContent },
      { role: "toolResult", content: text("peter@dc.io\n") },
    ]);
    expect(JSON.stringify(messages)).not.toContain("changed by hook");
  });
});

describe("flushPendingToolResultsAfterIdle", () => {
  it.each([false, true])(
    "settles pending tool results after idle or timeout (timeout=%s)",
    async (timesOut) => {
      vi.useFakeTimers();
      const id = timesOut ? "call_orphan_2" : "call_retry_1";
      const timeoutMs = timesOut ? 30 : 1_000;
      const { sm, appendMessage } = createGuard();
      const idle = createDeferredCore();
      appendMessage(assistantToolCall(id, "exec", "toolUse"));
      const flushPromise = flushPendingToolResultsAfterIdle({
        agent: { waitForIdle: () => idle.promise },
        sessionManager: sm,
        timeoutMs,
      });

      if (timesOut) {
        await vi.advanceTimersByTimeAsync(timeoutMs);
      } else {
        await Promise.resolve();
        expect(getMessages(sm).map((message) => message.role)).toEqual(["assistant"]);
        appendMessage({
          role: "toolResult",
          toolCallId: id,
          content: text("command output here"),
          isError: false,
        } as AgentMessage);
        idle.resolve();
      }
      await flushPromise;
      expect(vi.getTimerCount()).toBe(0);
      const messages = getMessages(sm);
      expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
      expect(messages[1]).toMatchObject(
        timesOut
          ? { toolCallId: id, isError: true }
          : { isError: false, content: text("command output here") },
      );
      if (timesOut) {
        appendMessage(makeUserMessage("still there?", Date.now()));
        expect(getMessages(sm).map((message) => message.role)).toEqual([
          "assistant",
          "toolResult",
          "user",
        ]);
      }
    },
  );
});

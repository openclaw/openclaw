import fs from "node:fs/promises";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { useSqliteWorkerFault } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type FakeSession,
  createFixture,
  createJournalSession,
  emitReplayGroup,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";

const toolResultFault = useSqliteWorkerFault([
  {
    name: "fail_copilot_tool_result",
    match: /^insert into transcript_events\b/u,
    sql: `CREATE TEMP TRIGGER fail_copilot_tool_result
      BEFORE INSERT ON main.transcript_events
      WHEN NEW.event_json LIKE '%result-failed%'
      BEGIN
        SELECT RAISE(ABORT, 'injected mid-group failure');
      END;`,
  },
]);

beforeEach(() => setRuntimeConfigSnapshot({}));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

type EventData = Record<string, unknown>;
type EventMeta = { agentId?: string; ephemeral?: boolean };

function assistantContent(bridge: ReturnType<typeof createJournalSession>["bridge"]) {
  return bridge.buildAssistantMessage({
    modelRef: { api: "openai-responses", id: "gpt-5", provider: "github-copilot" },
    now: () => 3,
  })?.content;
}

async function readRows(target: Parameters<typeof readSessionTranscriptEvents>[0]) {
  return transcriptMessages(await readSessionTranscriptEvents(target));
}

function installHook(handler: (message: AgentMessage) => unknown) {
  const hook = (input: unknown) => handler((input as { message: AgentMessage }).message);
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_message_write", handler: hook }]),
  );
}

function emitRead(session: FakeSession, id: string, toolCallId: string, content = "checking") {
  emitAssistant(session, id, {
    content,
    toolRequests: [{ arguments: {}, name: "read", toolCallId }],
  });
}

function emitToolResult(session: FakeSession, id: string, toolCallId: string, content: string) {
  emit(session, "tool.execution_complete", id, { result: { content }, success: true, toolCallId });
}

function emit(
  session: FakeSession,
  type: string,
  id: string,
  data: EventData,
  meta: EventMeta = {},
) {
  session.emit({ ...event(type, id, data), ...meta });
}

function emitAssistant(session: FakeSession, id: string, data: EventData) {
  emit(session, "assistant.message", id, { messageId: id, ...data });
}

async function createInitializedFixture() {
  const fixture = await createFixture();
  await fixture.journal.persistInitialUser();
  emit(fixture.session, "user.message", "initial-user", { content: "inspect both files" });
  return fixture;
}

describe("Copilot attempt transcript journal", () => {
  it("prepares standalone media after hooks without claiming user or tool-group media", async () => {
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const rewrittenText = `${sourceText}\nMEDIA:./hook-only.json`;
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => ({
      ...message,
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
    }));
    installHook((message) => {
      return message.role === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text === sourceText)
        ? { message: { ...message, content: [{ type: "text", text: rewrittenText }] } }
        : undefined;
    });
    const { attempt, journal, recorder, session, target } = await createFixture();
    Object.assign(attempt, { prepareAssistantTranscriptMessage });
    recorder.resolveMessage.mockResolvedValue({ role: "user", content: sourceText, timestamp: 1 });
    await journal.persistInitialUser();
    emit(session, "user.message", "initial-user", { content: sourceText });
    emitRead(session, "tool-assistant", "call-1", "MEDIA:./tool-only.json");
    emitToolResult(session, "tool-result", "call-1", "done");
    emitAssistant(session, "final-assistant", { content: sourceText });
    await journal.barrier("media preparation");

    expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: [{ type: "text", text: rewrittenText }] }),
      sourceText,
    );
    const persisted = (await readRows(target)).map((row) => row.message);
    expect(persisted.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(persisted[0]).toMatchObject({ role: "user", content: sourceText });
    expect(persisted.slice(0, -1).some((message) => "openclawDelivery" in message)).toBe(false);
    expect(persisted.at(-1)).toMatchObject({
      content: [{ type: "text", text: rewrittenText }],
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
      idempotencyKey: "copilot-sdk:sdk-session:final-assistant",
    });
    expect(journal.snapshot().messagesSnapshot).toEqual(persisted);
    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("drains work appended after a barrier starts waiting", async () => {
    const { journal, session } = await createInitializedFixture();
    emitAssistant(session, "assistant-before-barrier", { content: "first" });

    const waiting = journal.barrier("concurrent event");
    queueMicrotask(() => {
      emitAssistant(session, "assistant-after-barrier", { content: "second" });
    });
    await waiting;

    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "assistant",
    ]);
  });

  it("gives a queued tool completion one grace turn before failing the barrier", async () => {
    const { journal, session } = await createInitializedFixture();
    emitRead(session, "assistant-tools", "call-1");

    const waiting = journal.barrier("queued tool result");
    queueMicrotask(() => {
      emitToolResult(session, "tool-result", "call-1", "done");
    });
    await waiting;

    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("replaces the originally staged user when async resolution changes it", async () => {
    const { journal, recorder } = await createFixture();
    recorder.resolveMessage.mockResolvedValue({
      role: "user",
      content: "resolved user",
      timestamp: 2,
    });

    await journal.persistInitialUser();

    expect(journal.snapshot().messagesSnapshot).toMatchObject([
      { role: "user", content: "resolved user" },
    ]);
  });

  it("publishes the storage anchor without treating a replay as a fresh user append", async () => {
    const { journal, recorder } = await createFixture();

    await journal.persistInitialUser();

    const anchor = recorder.markRuntimePersisted.mock.calls[0]?.[1];
    expect(anchor).toBeDefined();
    expect(journal.snapshot().terminalAnchor).toEqual(anchor);
    expect(recorder.getAdmissionReceipt()).toEqual({
      ...anchor,
      logicalTurnId: "logical-turn-1",
      role: "user",
    });
    await journal.persistInitialUser();
    expect(recorder.markRuntimePersisted.mock.calls.map((call) => call[2])).toEqual([
      { appended: true },
      { appended: false },
    ]);
  });

  it.each(["unchanged", "sdk-rewrite", "hook-rewrite", "hook-metadata"] as const)(
    "keeps selected steering mentions only on unchanged committed text (%s)",
    async (rewrite) => {
      const { journal, recorder, session, target } = await createInitializedFixture();
      const mentions = [{ profileId: "profile-taylor", start: 3, end: 10 }];
      const sourceMessage = {
        role: "user" as const,
        content: "Hi @Taylor",
        timestamp: 3,
        provenance: { kind: "external_user" as const },
        __openclaw: { humanMentions: mentions },
      };
      const sourceRecorder = {
        ...recorder,
        message: sourceMessage,
        resolveMessage: vi.fn(async () => sourceMessage),
        markRuntimePersisted: vi.fn(),
      };
      installHook((message) => {
        if (rewrite === "hook-rewrite") {
          Object.assign(message, { content: "Changed @Taylor" });
        }
        if (rewrite === "hook-metadata") {
          Object.assign(message, {
            __openclaw: {
              humanMentions: [{ profileId: "profile-other", start: 3, end: 10 }],
            },
          });
        }
        return { message };
      });

      await journal.sendSdkUser(async () => "selected-steering", sourceRecorder);
      emit(session, "user.message", "selected-steering", {
        content: rewrite === "sdk-rewrite" ? "Changed @Taylor" : sourceMessage.content,
      });
      await journal.waitForSdkUserPersisted("selected-steering");

      const persisted = (await readRows(target)).at(-1);
      const contentChanged = rewrite === "sdk-rewrite" || rewrite === "hook-rewrite";
      expect(persisted?.message).toMatchObject({
        role: "user",
        content: contentChanged ? "Changed @Taylor" : sourceMessage.content,
        provenance: sourceMessage.provenance,
      });
      if (contentChanged) {
        expect(persisted?.message).not.toHaveProperty("__openclaw.humanMentions");
      } else {
        expect(persisted?.message).toHaveProperty("__openclaw.humanMentions", mentions);
      }
      expect(sourceRecorder.markRuntimePersisted).toHaveBeenCalledExactlyOnceWith(
        persisted?.message,
        expect.objectContaining({ entryId: "selected-steering" }),
        { appended: true },
      );
    },
  );

  it.each(["resolved replacement", "already blocked"] as const)(
    "omits the %s initial user",
    async (mode) => {
      const { journal, recorder } = await createFixture();
      if (mode === "already blocked") {
        recorder.markBlocked();
      } else {
        installHook((message) => (message.role === "user" ? { block: true } : undefined));
        recorder.resolveMessage.mockResolvedValue({
          role: "user",
          content: "blocked resolved user",
          timestamp: 2,
        });
      }
      await journal.persistInitialUser();
      expect(journal.snapshot()).toMatchObject({ messagesSnapshot: [], replayInvalid: true });
      if (mode === "resolved replacement") {
        expect(recorder.markBlocked).toHaveBeenCalledOnce();
      }
    },
  );

  it.each([
    ["empty transform", "user.message", { content: "original", transformedContent: "" }],
    ["mismatched initial user", "user.message", { content: "provider saw different" }],
    ["plan user", "user.message", { content: "inspect both files", agentMode: "plan" }],
    ["system prompt", "system.message", { content: "injected", role: "system" }],
    ["developer prompt", "system.message", { content: "injected", role: "developer" }],
  ] satisfies Array<[string, string, EventData]>)(
    "marks %s replay-incomplete",
    async (name, type, data) => {
      const { journal, session } = await createFixture();
      await journal.persistInitialUser();
      emit(session, type, name, data);
      await journal.barrier(name);
      expect(journal.snapshot().replayInvalid).toBe(true);
    },
  );

  it("marks durable skill injection replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("skill.invoked", "skill-invoked", {
        content: "full injected skill content",
        name: "example-skill",
        path: "/skills/example/SKILL.md",
      }),
    );
    await journal.barrier("skill invocation");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("marks durable system notifications replay-incomplete", async () => {
    const { journal, session } = await createFixture();
    await journal.persistInitialUser();
    session.emit(
      event("system.notification", "system-notification", { content: "background task done" }),
    );
    await journal.barrier("system notification");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("marks orphaned durable reasoning replay-incomplete at terminal flush", async () => {
    const { bridge, journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    emit(session, "assistant.reasoning", "orphaned-reasoning", {
      content: "durable thinking without a message",
      reasoningId: "reasoning-1",
    });
    bridge.flushTranscriptProjection();
    emitAssistant(session, "next-assistant", { content: "next turn" });
    await journal.barrier("orphaned reasoning");

    expect(journal.snapshot().replayInvalid).toBe(true);
    const assistant = (await readRows(target)).find(
      (row) => row.message.role === "assistant",
    )?.message;
    expect(assistant).toMatchObject({
      content: [{ type: "text", text: "next turn" }],
    });
  });

  it.each(["assistant", "toolResult"] as const)("blocks %s writes atomically", async (role) => {
    installHook((message) => (message.role === role ? { block: true } : undefined));
    const { journal, session, target } = await createInitializedFixture();
    const group = role === "toolResult";
    emitAssistant(session, "blocked-assistant", {
      content: group ? "checking" : "provider-visible response",
      ...(group
        ? { toolRequests: [{ arguments: {}, name: "read", toolCallId: "call-blocked" }] }
        : {}),
    });
    if (group) {
      emitToolResult(session, "result-blocked", "call-blocked", "secret");
    }
    await journal.barrier("blocked write");
    expect((await readRows(target)).map((row) => row.message.role)).toEqual(["user"]);
    expect(journal.snapshot()).toMatchObject({
      replayInvalid: true,
      ...(group ? { assistantTranscriptOwned: true } : {}),
    });
  });

  it("keeps replay valid for semantically equal hook payloads with reordered keys", async () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (input: unknown) => {
            const message = (input as { message: AgentMessage }).message;
            if (message.role !== "assistant") {
              return undefined;
            }
            return {
              message: {
                ...message,
                content: message.content.map((part) =>
                  part.type === "text" ? { type: "text" as const, text: part.text } : part,
                ),
              },
            };
          },
        },
      ]),
    );
    const { journal, session } = await createInitializedFixture();
    emitAssistant(session, "same-content", { content: "same" });
    await journal.barrier("same semantic content");

    expect(journal.snapshot().replayInvalid).toBe(false);
  });

  it("rejects structurally destructive singleton hook replacements", async () => {
    for (const replacement of [
      { role: "user", content: "changed role", timestamp: 2 } as AgentMessage,
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "injected", name: "read", arguments: {} }],
        provider: "github-copilot",
        model: "gpt-5",
        stopReason: "toolUse",
        timestamp: 2,
      } as AgentMessage,
    ]) {
      resetGlobalHookRunner();
      installHook((message) => {
        if (message.role !== "assistant") {
          return undefined;
        }
        Object.assign(message, replacement);
        return { message };
      });
      const { journal, session, target } = await createInitializedFixture();
      emitAssistant(session, "rewritten-assistant", { content: "provider-visible response" });
      await journal.barrier("rewritten assistant");

      expect(journal.snapshot().replayInvalid).toBe(true);
      expect((await readRows(target)).map((row) => row.message.role)).toEqual(["user"]);
    }
  });

  it("commits a hidden tool turn to SQLite in assistant request order", async () => {
    const { attempt, bridge, journal, recorder, session, target, tempDir } = await createFixture(
      "memory",
      new Map<string, "network">([["read", "network"]]),
    );
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => message);
    Object.assign(attempt, { prepareAssistantTranscriptMessage });
    await journal.persistInitialUser();
    expect(recorder.markRuntimePersisted).toHaveBeenCalledOnce();

    emit(session, "user.message", "sdk-user", { content: "inspect both files" });
    emit(session, "assistant.usage", "prior-usage", {
      apiCallId: "prior-call",
      inputTokens: 50,
      model: "gpt-5",
      outputTokens: 40,
    });
    const toolAssistant = event("assistant.message", "assistant-tools", {
      content: "checking",
      messageId: "assistant-tools-message",
      model: "gpt-5",
      toolRequests: [
        { arguments: { path: "a" }, name: "read", toolCallId: "call-a" },
        { arguments: { path: "b" }, name: "read", toolCallId: "call-b" },
      ],
    });
    session.emit(toolAssistant);
    emit(session, "tool.execution_start", "start-a", { toolCallId: "call-a", toolName: "read" });
    emit(session, "tool.execution_start", "start-b", { toolCallId: "call-b", toolName: "read" });
    emit(session, "tool.execution_complete", "result-b", {
      result: { content: "B", detailedContent: "details B" },
      success: true,
      toolCallId: "call-b",
    });
    emit(session, "user.message", "steering-user", {
      content: "steer after tools",
      delivery: "steering",
      source: "future-steering-source",
    });
    emit(
      session,
      "tool.execution_complete",
      "result-child",
      {
        result: { content: "child" },
        success: true,
        toolCallId: "child-call",
      },
      { agentId: "child-1" },
    );
    emit(
      session,
      "tool.execution_complete",
      "ephemeral-result-a",
      {
        result: { content: "transient" },
        success: true,
        toolCallId: "call-a",
      },
      { ephemeral: true },
    );
    emit(session, "tool.execution_complete", "result-a", {
      error: { message: "A failed" },
      success: false,
      toolCallId: "call-a",
    });
    const finalAssistant = event("assistant.message", "assistant-final", {
      content: "finished",
      messageId: "assistant-final-message",
      model: "gpt-5",
    });
    session.emit(finalAssistant);
    bridge.recordSendResult(finalAssistant);
    emit(session, "session.idle", "idle", {});
    await journal.barrier("test");

    const rows = await readRows(target);
    expect(rows[0]?.message.role).toBe("user");
    expect(rows.slice(1).map(({ id, message }) => [id, message.role])).toEqual([
      ["assistant-tools", "assistant"],
      ["result-a", "toolResult"],
      ["result-b", "toolResult"],
      ["steering-user", "user"],
      ["assistant-final", "assistant"],
    ]);
    expect(rows.map((row) => row.parentId).slice(1)).toEqual(
      rows.map((row) => row.id).slice(0, -1),
    );
    expect(rows.every((row) => row.message.display === false)).toBe(true);
    expect(prepareAssistantTranscriptMessage).not.toHaveBeenCalled();
    expect(rows[0]?.message.idempotencyKey).toBe("run-1:user");
    expect(rows[1]?.message).toMatchObject({ usage: { input: 0, output: 0 } });
    expect(rows[5]?.message).toMatchObject({
      content: [{ type: "text", text: "finished" }],
      idempotencyKey: "copilot-sdk:sdk-session:assistant-final",
      __openclaw: { turnTainted: true },
    });
    expect(rows[2]?.message).toMatchObject({
      isError: true,
      toolCallId: "call-a",
      content: [{ type: "text", text: "A failed" }],
      __openclaw: { resultContentSource: "network" },
    });
    expect(journal.snapshot()).toMatchObject({
      assistantTranscriptOwned: true,
      assistantTranscriptIdempotencyKey: "copilot-sdk:sdk-session:assistant-final",
      replayInvalid: false,
    });
    expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual(
      rows.map((row) => row.message.role),
    );
    const files = await fs.readdir(tempDir, { recursive: true });
    expect(files.some((file) => file.endsWith(".jsonl"))).toBe(false);
  });

  it("groups assistant chunks from one API call before matching tool results", async () => {
    const { bridge, journal, session, target } = await createInitializedFixture();
    emitAssistant(session, "assistant-chunk-a", {
      apiCallId: "api-call-1",
      content: "checking ",
      reasoningText: "partial reasoning",
      toolRequests: [{ arguments: { path: "a" }, name: "read", toolCallId: "call-a" }],
    });
    emitAssistant(session, "assistant-chunk-b", {
      apiCallId: "api-call-1",
      content: "now",
      reasoningText: "complete reasoning",
    });
    emitToolResult(session, "result-a", "call-a", "done");
    await journal.barrier("grouped API call");

    const expectedContent = [
      { type: "thinking", thinking: "complete reasoning" },
      { type: "text", text: "checking now" },
      { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
    ];
    const rows = await readRows(target);
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant", "toolResult"]);
    expect(rows[1]?.message).toMatchObject({
      content: expectedContent,
      idempotencyKey: "copilot-sdk:sdk-session:assistant-chunk-a",
      stopReason: "toolUse",
    });
    expect(rows[2]?.message).toMatchObject({ toolCallId: "call-a", toolName: "read" });
    expect(journal.snapshot().terminalAnchor?.entryId).toBe(rows[2]?.id);
    expect(assistantContent(bridge)).toEqual(expectedContent);
    expect(journal.snapshot().replayInvalid).toBe(false);
  });

  it.each([true, false])("reconciles snapshots with API id=%s", async (withApiId) => {
    const { bridge, journal, session, target } = await createInitializedFixture();
    const identity = {
      messageId: "assistant-snapshot",
      ...(withApiId ? { apiCallId: "api-call-snapshot" } : {}),
    };
    emitAssistant(session, "assistant-snapshot-a", { ...identity, content: "checking" });
    emitAssistant(session, "assistant-snapshot-b", { ...identity, content: "checking now" });
    bridge.flushTranscriptProjection();
    await journal.barrier("cumulative assistant snapshot");
    const rows = await readRows(target);
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant"]);
    expect(rows.at(-1)?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: withApiId ? "checking now" : "checking" }],
    });
    expect(assistantContent(bridge)).toEqual([{ type: "text", text: "checking now" }]);
    expect(journal.snapshot().replayInvalid).toBe(!withApiId);
  });

  it("keeps ephemeral deltas out of the durable assistant row", async () => {
    const { journal, session, target } = await createInitializedFixture();
    session.emit({
      ...event("assistant.message_delta", "ephemeral-text", {
        deltaContent: "stream-only text",
        messageId: "stream-only",
      }),
      ephemeral: true,
    } as SessionEvent);
    session.emit({
      ...event("assistant.reasoning_delta", "ephemeral-reasoning", {
        deltaContent: "stream-only reasoning",
        reasoningId: "stream-reasoning",
      }),
      ephemeral: true,
    } as SessionEvent);
    emitAssistant(session, "durable-assistant", { content: "visible" });
    await journal.barrier("ephemeral deltas");

    const assistant = transcriptMessages(await readSessionTranscriptEvents(target)).find(
      (row) => row.message.role === "assistant",
    )?.message;
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
    });
  });

  it("clears prior assistant ownership when the final durable projection is empty", async () => {
    const { bridge, journal, session } = await createInitializedFixture();
    emitRead(session, "tool-assistant", "call-1");
    emitToolResult(session, "tool-result", "call-1", "done");
    emit(
      session,
      "assistant.message_delta",
      "final-delta",
      {
        deltaContent: "streamed final",
        messageId: "final-message",
      },
      { ephemeral: true },
    );
    emitAssistant(session, "final-empty", { content: "", messageId: "final-message" });
    bridge.flushTranscriptProjection();
    await journal.barrier("empty final projection");

    expect(journal.snapshot()).toMatchObject({
      assistantTranscriptOwned: false,
      replayInvalid: true,
    });
    expect(assistantContent(bridge)).toEqual([{ type: "text", text: "streamed final" }]);
  });

  it.each([
    {
      name: "provider round-trip state",
      data: {
        content: "",
        reasoningWireField: "reasoning_content",
        serverTools: { provider: "openai", items: [{ type: "web_search" }] },
      },
      usage: { outputTokens: 1 },
      roles: ["user"],
    },
    {
      name: "citation metadata",
      data: { content: "cited response", citations: { sources: [], spans: [] } },
      roles: ["user", "assistant"],
    },
    {
      name: "encrypted reasoning",
      data: { content: "", encryptedContent: "encrypted-openai-state" },
      usage: {},
    },
    {
      name: "opaque reasoning",
      data: { content: "", reasoningOpaque: "opaque-anthropic-state" },
      usage: {},
    },
    {
      name: "custom tool calls",
      data: {
        content: "run custom tool",
        toolRequests: [
          {
            arguments: { input: "value" },
            name: "custom_tool",
            toolCallId: "custom-call",
            type: "custom",
          },
        ],
      },
      toolResult: true,
    },
  ] satisfies Array<{
    name: string;
    data: EventData;
    usage?: EventData;
    roles?: string[];
    toolResult?: boolean;
  }>)("marks $name replay-incomplete", async ({ name, data, usage, roles, toolResult }) => {
    const { journal, session } = await createInitializedFixture();
    emitAssistant(session, "assistant", { ...(usage ? { apiCallId: "api-call" } : {}), ...data });
    if (usage) {
      emit(session, "assistant.usage", "usage", {
        apiCallId: "api-call",
        model: "gpt-5",
        ...usage,
      });
    }
    if (toolResult) {
      emitToolResult(session, "custom-result", "custom-call", "done");
    }
    await journal.barrier(name);
    expect(journal.snapshot()).toMatchObject({
      replayInvalid: true,
      ...(roles ? { messagesSnapshot: roles.map((role) => ({ role })) } : {}),
    });
  });

  it("preserves user-requested identity across an ephemeral completion", async () => {
    const { journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    emit(session, "tool.user_requested", "user-tool-request", {
      arguments: { path: "a" },
      toolCallId: "user-call",
      toolName: "read",
    });
    emit(
      session,
      "tool.execution_complete",
      "ephemeral-user-tool-result",
      {
        result: { content: "partial" },
        success: true,
        toolCallId: "user-call",
      },
      { ephemeral: true },
    );
    emitToolResult(session, "durable-user-tool-result", "user-call", "done");
    await journal.barrier("user-requested completion");

    expect(await readRows(target)).toHaveLength(1);
    expect(journal.snapshot()).toMatchObject({ replayInvalid: true });
  });

  it("hides autopilot users while preserving unknown SDK source provenance", async () => {
    installHook((message) => {
      const replacement = { ...message };
      delete (replacement as { display?: boolean }).display;
      return { message: replacement };
    });
    const { journal, session, target } = await createInitializedFixture();
    emit(session, "user.message", "autopilot-user", {
      content: "continue",
      attachments: [
        {
          type: "file",
          mimeType: "text/plain",
          path: "/tmp/notes.txt",
        },
        {
          type: "blob",
          data: "c2VjcmV0LWJ5dGVz",
        },
      ],
      isAutopilotContinuation: true,
      source: "future-source-kind",
    });
    emit(session, "tool.execution_complete", "user-tool-result", {
      isUserRequested: true,
      result: { content: "user tool result" },
      success: true,
      toolCallId: "user-call",
    });
    emit(session, "user.message", "skill-user", {
      content: "injected skill context",
      source: "skill-pdf",
    });
    emit(session, "user.message", "unknown-user", {
      content: "unknown source context",
      source: "future-visible-source",
    });
    await journal.barrier("test");

    const rows = await readRows(target);
    expect(rows).toHaveLength(4);
    expect(rows[1]?.message).toMatchObject({
      role: "user",
      content: "continue",
      display: false,
      __openclaw: {
        copilotSource: "future-source-kind",
        media: [{ path: "/tmp/notes.txt", contentType: "text/plain" }],
        copilotAttachments: [
          expect.objectContaining({ type: "file", path: "/tmp/notes.txt" }),
          expect.not.objectContaining({ data: expect.anything() }),
        ],
      },
    });
    expect(rows[2]?.message).toMatchObject({ display: false });
    expect(rows[3]?.message).not.toHaveProperty("display", false);
    expect(rows[3]?.message).toMatchObject({
      __openclaw: { copilotSource: "future-visible-source" },
    });
    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("keeps a complete-group prefix when the next group is interrupted", async () => {
    const { journal, session, target } = await createInitializedFixture();
    emitRead(session, "assistant-complete", "call-complete", "first");
    emitToolResult(session, "result-complete", "call-complete", "done");
    await journal.barrier("complete group");
    emitRead(session, "assistant-open", "call-open", "second");

    await expect(journal.barrier("abort")).rejects.toMatchObject({
      code: "transcript_persistence_failed",
    });
    const rows = await readRows(target);
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("does not rerun group hooks for an idempotent replay", async () => {
    const hook = vi.fn(() => undefined);
    installHook(hook);
    const { attempt, journal, session, target } = await createFixture();
    await journal.persistInitialUser();
    emitReplayGroup(session);
    await journal.barrier("first commit");
    expect(hook).toHaveBeenCalledTimes(3);
    const existingMessages = (await readRows(target)).map((row) => row.message);

    const { session: replaySession, journal: replayJournal } = createJournalSession(
      attempt,
      existingMessages,
    );
    await replayJournal.persistInitialUser();
    emitReplayGroup(replaySession);
    await replayJournal.barrier("replay");

    expect(hook).toHaveBeenCalledTimes(3);
    expect(await readRows(target)).toHaveLength(3);
    expect(replayJournal.snapshot().messagesSnapshot).toHaveLength(3);
  });

  it("rolls back the complete group when SQLite fails mid-group", async () => {
    const { journal, session, target } = await createInitializedFixture();
    toolResultFault.enable();
    emitRead(session, "assistant-failed", "call-failed");
    emitToolResult(session, "result-failed", "call-failed", "never committed");

    await expect(journal.barrier("failed group")).rejects.toThrow("injected mid-group failure");
    expect((await readRows(target)).map((row) => row.message.role)).toEqual(["user"]);
  });
});

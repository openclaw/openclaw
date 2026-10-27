import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { listDirectoryTreeStrict } from "openclaw/plugin-sdk/file-access-runtime";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeUserMessage } from "../../test-support/message-fixtures.test-support.js";
import {
  createFixture as createBaseFixture,
  installJournalMessageWriteHook,
  createJournalSession,
  emitReplayGroup,
  event,
  transcriptMessages,
} from "./attempt-transcript-journal.test-helpers.js";

beforeEach(() => setRuntimeConfigSnapshot({}));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  resetGlobalHookRunner();
  vi.restoreAllMocks();
});

function emitAssistant(
  session: ReturnType<typeof createJournalSession>["session"],
  id: string,
  data: Record<string, unknown>,
) {
  session.emit(event("assistant.message", id, { messageId: id, ...data }));
}

function emitToolSuccess(
  session: ReturnType<typeof createJournalSession>["session"],
  id: string,
  toolCallId: string,
  content = "done",
) {
  session.emit(
    event("tool.execution_complete", id, { result: { content }, success: true, toolCallId }),
  );
}

function emitEphemeral(
  session: ReturnType<typeof createJournalSession>["session"],
  type: string,
  id: string,
  data: Record<string, unknown>,
) {
  session.emit(Object.assign(event(type, id, data), { ephemeral: true }));
}

function readRows(target: Parameters<typeof readSessionTranscriptEvents>[0]) {
  return readSessionTranscriptEvents(target).then(transcriptMessages);
}

function toolRequest(toolCallId: string, args: Record<string, unknown> = {}) {
  return { arguments: args, name: "read", toolCallId };
}

function emitToolTurn(
  session: ReturnType<typeof createJournalSession>["session"],
  suffix: string,
  content: string,
  result: string,
) {
  emitAssistant(session, `assistant-${suffix}`, {
    content,
    toolRequests: [toolRequest(`call-${suffix}`)],
  });
  emitToolSuccess(session, `result-${suffix}`, `call-${suffix}`, result);
}

function assistantContent(bridge: ReturnType<typeof createJournalSession>["bridge"]) {
  return bridge.buildAssistantMessage({
    modelRef: { api: "openai-responses", id: "gpt-5", provider: "github-copilot" },
    now: () => 3,
  })?.content;
}

function installMessageHook(
  handler: (
    message: AgentMessage,
  ) => ReturnType<Parameters<typeof installJournalMessageWriteHook>[0]>,
) {
  installJournalMessageWriteHook((input: unknown) =>
    handler((input as { message: AgentMessage }).message),
  );
}

async function createInitializedFixture() {
  const fixture = await createFixture();
  await fixture.journal.persistInitialUser();
  fixture.session.emit(event("user.message", "initial-user", { content: "inspect both files" }));
  return fixture;
}

async function createFixture(...args: Parameters<typeof createBaseFixture>) {
  const fixture = await createBaseFixture(...args);
  return {
    ...fixture,
    emit(type: string, id: string, data: Record<string, unknown>, agentId?: string) {
      fixture.session.emit(event(type, id, data, agentId));
    },
  };
}

describe("Copilot attempt transcript journal", () => {
  it("keeps scheduled assistant prose audit-only for final cron publication", async () => {
    const { attempt, journal, session, target } = await createInitializedFixture();
    attempt.inputProvenance = { kind: "internal_system", sourceTool: "cron_execution" };
    emitAssistant(session, "scheduled-prose", { content: "Still waiting." });
    await journal.barrier("test");
    const rows = await readRows(target);
    expect(rows.at(-1)?.message).toMatchObject({ role: "assistant", display: false });
  });

  it("prepares standalone media after hooks without claiming user or tool-group media", async () => {
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const rewrittenText = `${sourceText}\nMEDIA:./hook-only.json`;
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => ({
      ...message,
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
    }));
    installMessageHook((message) =>
      message.role === "assistant" &&
      message.content.some((part) => part.type === "text" && part.text === sourceText)
        ? { message: { ...message, content: [{ type: "text", text: rewrittenText }] } }
        : undefined,
    );
    const { attempt, journal, recorder, session, target } = await createFixture();
    Object.assign(attempt, { prepareAssistantTranscriptMessage });
    recorder.resolveMessage.mockResolvedValue({ role: "user", content: sourceText, timestamp: 1 });
    await journal.persistInitialUser();
    session.emit(event("user.message", "initial-user", { content: sourceText }));
    emitAssistant(session, "tool-assistant", {
      content: "MEDIA:./tool-only.json",
      toolRequests: [toolRequest("call-1")],
    });
    emitToolSuccess(session, "tool-result", "call-1");
    emitAssistant(session, "final-assistant", { content: sourceText });
    await journal.barrier("media preparation");

    expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: [{ type: "text", text: rewrittenText }] }),
      sourceText,
    );
    const persisted = (await readRows(target)).map((row) => row.message);
    expect(persisted).toMatchObject([
      { role: "user", content: sourceText },
      { role: "assistant" },
      { role: "toolResult" },
      { role: "assistant" },
    ]);
    expect(persisted.slice(0, -1).some((message) => "openclawDelivery" in message)).toBe(false);
    expect(persisted.at(-1)).toMatchObject({
      content: [{ type: "text", text: rewrittenText }],
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
      idempotencyKey: "copilot-sdk:sdk-session:final-assistant",
    });
    expect(journal.snapshot().messagesSnapshot).toEqual(persisted);
    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it.each([false, true])(
    "drains a queued event after the barrier starts (tool: %s)",
    async (tool) => {
      const { journal, session } = await createInitializedFixture();
      emitAssistant(session, "assistant-before-barrier", {
        content: "checking",
        ...(tool ? { toolRequests: [toolRequest("call-1")] } : {}),
      });
      const waiting = journal.barrier("queued event");
      queueMicrotask(() => {
        if (tool) {
          emitToolSuccess(session, "tool-result", "call-1");
        } else {
          emitAssistant(session, "assistant-after-barrier", { content: "second" });
        }
      });
      await waiting;
      expect(journal.snapshot().messagesSnapshot.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        tool ? "toolResult" : "assistant",
      ]);
    },
  );

  it("replaces the originally staged user when async resolution changes it", async () => {
    const { journal, recorder } = await createFixture();
    recorder.resolveMessage.mockResolvedValue(makeUserMessage("resolved user", 2));

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
      const { journal, recorder, emit, target } = await createInitializedFixture();
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
      installMessageHook((message) => {
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
      emit("user.message", "selected-steering", {
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

  it("removes the originally staged user when its resolved replacement is blocked", async () => {
    installMessageHook((message) => (message.role === "user" ? { block: true } : undefined));
    const { journal, recorder } = await createFixture();
    recorder.resolveMessage.mockResolvedValue(makeUserMessage("blocked resolved user", 2));

    await journal.persistInitialUser();

    expect(journal.snapshot()).toMatchObject({ messagesSnapshot: [], replayInvalid: true });
    expect(recorder.markBlocked).toHaveBeenCalledOnce();
  });

  it("marks an already-blocked initial user replay-incomplete", async () => {
    const { journal, recorder } = await createFixture();
    recorder.markBlocked();

    await journal.persistInitialUser();

    expect(journal.snapshot()).toMatchObject({ messagesSnapshot: [], replayInvalid: true });
  });

  it.each([
    [
      "empty transformed user",
      "user.message",
      { content: "provider-visible original", transformedContent: "" },
    ],
    ["mismatched initial user", "user.message", { content: "provider saw different" }],
    ["non-interactive user", "user.message", { agentMode: "plan", content: "inspect both files" }],
    ["system prompt", "system.message", { content: "injected", role: "system" }],
    ["developer prompt", "system.message", { content: "injected", role: "developer" }],
    [
      "skill injection",
      "skill.invoked",
      {
        content: "full injected skill content",
        name: "example-skill",
        path: "/skills/example/SKILL.md",
      },
    ],
    ["system notification", "system.notification", { content: "background task done" }],
  ] satisfies Array<[string, string, Record<string, unknown>]>)(
    "marks %s replay-incomplete",
    async (name, type, data) => {
      const { journal, session } = await createFixture();
      await journal.persistInitialUser();
      session.emit(event(type, name, data));
      await journal.barrier(name);
      expect(journal.snapshot().replayInvalid).toBe(true);
    },
  );

  it("marks orphaned durable reasoning replay-incomplete at terminal flush", async () => {
    const { bridge, journal, session, emit, target } = await createFixture();
    await journal.persistInitialUser();
    emit("assistant.reasoning", "orphaned-reasoning", {
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

  it.each([
    "same",
    undefined,
    { role: "user", content: "changed role" },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "injected", name: "read", arguments: {} }],
    },
  ])(
    "preserves equivalent payloads and suppresses destructive singleton hooks (%j)",
    async (replacement) => {
      installMessageHook((message) => {
        if (message.role !== "assistant") {
          return undefined;
        }
        if (!replacement) {
          return { block: true };
        }
        if (replacement === "same") {
          return {
            message: { ...message, content: [{ type: "text", text: "provider-visible response" }] },
          };
        }
        Object.assign(message, replacement);
        return { message };
      });
      const { journal, session, target } = await createInitializedFixture();
      emitAssistant(session, "rewritten-assistant", { content: "provider-visible response" });
      await journal.barrier("rewritten assistant");

      expect(journal.snapshot().replayInvalid).toBe(replacement !== "same");
      expect((await readRows(target)).map((row) => row.message.role)).toEqual(
        replacement === "same" ? ["user", "assistant"] : ["user"],
      );
    },
  );

  it("commits a hidden tool turn to SQLite in assistant request order", async () => {
    const { attempt, bridge, journal, recorder, session, emit, target, tempDir } =
      await createFixture("memory", new Map<string, "network">([["read", "network"]]));
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => message);
    Object.assign(attempt, { prepareAssistantTranscriptMessage });
    await journal.persistInitialUser();
    expect(recorder.markRuntimePersisted).toHaveBeenCalledOnce();

    emit("user.message", "sdk-user", { content: "inspect both files" });
    emit("assistant.usage", "prior-usage", {
      apiCallId: "prior-call",
      inputTokens: 50,
      model: "gpt-5",
      outputTokens: 40,
    });
    emitAssistant(session, "assistant-tools", {
      content: "checking",
      toolRequests: [toolRequest("call-a", { path: "a" }), toolRequest("call-b", { path: "b" })],
    });
    for (const id of ["a", "b"]) {
      emit("tool.execution_start", `start-${id}`, { toolCallId: `call-${id}`, toolName: "read" });
    }
    emit("tool.execution_complete", "result-b", {
      result: { content: "B", detailedContent: "details B" },
      success: true,
      toolCallId: "call-b",
    });
    emit("user.message", "steering-user", {
      content: "steer after tools",
      delivery: "steering",
      source: "future-steering-source",
    });
    emit(
      "tool.execution_complete",
      "result-child",
      {
        result: { content: "child" },
        success: true,
        toolCallId: "child-call",
      },
      "child-1",
    );
    emitEphemeral(session, "tool.execution_complete", "ephemeral-result-a", {
      result: { content: "transient" },
      success: true,
      toolCallId: "call-a",
    });
    emit("tool.execution_complete", "result-a", {
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
    emit("session.idle", "idle", {});
    await journal.barrier("test");

    const rows = await readRows(target);
    expect(rows.map((row) => row.message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
      "assistant",
    ]);
    expect(rows.map((row) => row.id).slice(1)).toEqual([
      "assistant-tools",
      "result-a",
      "result-b",
      "steering-user",
      "assistant-final",
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
    const files = (await listDirectoryTreeStrict(tempDir)).map(
      (walkEntry) => walkEntry.relativePath,
    );
    expect(files.some((file) => file.endsWith(".jsonl"))).toBe(false);
  });

  it("groups assistant chunks from one API call before matching tool results", async () => {
    const { bridge, journal, session, target } = await createInitializedFixture();
    emitAssistant(session, "assistant-chunk-a", {
      apiCallId: "api-call-1",
      content: "checking ",
      reasoningText: "partial reasoning",
      toolRequests: [toolRequest("call-a", { path: "a" })],
    });
    emitAssistant(session, "assistant-chunk-b", {
      apiCallId: "api-call-1",
      content: "now",
      reasoningText: "complete reasoning",
    });
    emitToolSuccess(session, "result-a", "call-a");
    await journal.barrier("grouped API call");

    const rows = await readRows(target);
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant", "toolResult"]);
    const content = [
      { type: "thinking", thinking: "complete reasoning" },
      { type: "text", text: "checking now" },
      { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
    ];
    expect(rows[1]?.message).toMatchObject({
      content,
      idempotencyKey: "copilot-sdk:sdk-session:assistant-chunk-a",
      stopReason: "toolUse",
    });
    expect(rows[2]?.message).toMatchObject({ toolCallId: "call-a", toolName: "read" });
    expect(journal.snapshot().terminalAnchor?.entryId).toBe(rows[2]?.id);
    expect(assistantContent(bridge)).toEqual(content);
    expect(journal.snapshot().replayInvalid).toBe(false);
  });

  it.each(["api-call-snapshot", undefined])(
    "persists cumulative snapshots only with an API call id (%s)",
    async (apiCallId) => {
      const { bridge, journal, session, target } = await createInitializedFixture();
      for (const [id, content] of [
        ["a", "checking"],
        ["b", "checking now"],
      ] as const) {
        emitAssistant(session, `assistant-snapshot-${id}`, {
          ...(apiCallId ? { apiCallId } : {}),
          content,
          messageId: "assistant-snapshot",
        });
      }
      bridge.flushTranscriptProjection();
      await journal.barrier("cumulative assistant snapshot");

      const rows = await readRows(target);
      expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant"]);
      expect(rows.at(-1)?.message).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: apiCallId ? "checking now" : "checking" }],
      });
      expect(assistantContent(bridge)).toEqual([{ type: "text", text: "checking now" }]);
      expect(journal.snapshot().replayInvalid).toBe(apiCallId === undefined);
    },
  );

  it("keeps ephemeral deltas out of the durable assistant row", async () => {
    const { journal, session, target } = await createInitializedFixture();
    emitEphemeral(session, "assistant.message_delta", "ephemeral-text", {
      deltaContent: "stream-only text",
      messageId: "stream-only",
    });
    emitEphemeral(session, "assistant.reasoning_delta", "ephemeral-reasoning", {
      deltaContent: "stream-only reasoning",
      reasoningId: "stream-reasoning",
    });
    emitAssistant(session, "durable-assistant", { content: "visible" });
    await journal.barrier("ephemeral deltas");

    const assistant = (await readRows(target)).find(
      (row) => row.message.role === "assistant",
    )?.message;
    expect(assistant).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "visible" }],
    });
  });

  it("clears prior assistant ownership when the final durable projection is empty", async () => {
    const { bridge, journal, session } = await createInitializedFixture();
    emitAssistant(session, "tool-assistant", {
      content: "checking",
      toolRequests: [toolRequest("call-1")],
    });
    emitToolSuccess(session, "tool-result", "call-1");
    emitEphemeral(session, "assistant.message_delta", "final-delta", {
      deltaContent: "streamed final",
      messageId: "final-message",
    });
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
    ["reasoning wire field", { reasoningWireField: "reasoning_content" }, false],
    [
      "server tools",
      { serverTools: { provider: "openai", items: [{ type: "web_search" }] } },
      false,
    ],
    ["encrypted reasoning", { encryptedContent: "encrypted-openai-state" }, false],
    ["opaque reasoning", { reasoningOpaque: "opaque-anthropic-state" }, false],
    [
      "citations",
      {
        content: "cited response",
        citations: {
          sources: [
            { id: "source-1", provider: "openai", title: "Example", url: "https://example.com" },
          ],
          spans: [{ endIndex: 5, references: [{ sourceId: "source-1" }], startIndex: 0 }],
        },
      },
      true,
    ],
  ] satisfies Array<[string, Record<string, unknown>, boolean]>)(
    "marks unprojectable %s replay-incomplete",
    async (name, data, hasAssistant) => {
      const { journal, session, emit } = await createInitializedFixture();
      emitAssistant(session, "unprojectable", { apiCallId: "api-call", content: "", ...data });
      emit("assistant.usage", "usage", { apiCallId: "api-call", model: "gpt-5", outputTokens: 1 });
      await journal.barrier(name);
      expect(journal.snapshot()).toMatchObject({
        messagesSnapshot: hasAssistant
          ? [{ role: "user" }, { role: "assistant" }]
          : [{ role: "user" }],
        replayInvalid: true,
      });
    },
  );

  it("marks custom tool calls replay-incomplete", async () => {
    const { journal, session } = await createInitializedFixture();
    emitAssistant(session, "assistant-custom-tool", {
      content: "run custom tool",
      toolRequests: [
        {
          arguments: { input: "value" },
          name: "custom_tool",
          toolCallId: "custom-call",
          type: "custom",
        },
      ],
    });
    emitToolSuccess(session, "custom-result", "custom-call");
    await journal.barrier("custom tool group");

    expect(journal.snapshot().replayInvalid).toBe(true);
  });

  it("preserves user-requested identity across an ephemeral completion", async () => {
    const { journal, session, emit, target } = await createFixture();
    await journal.persistInitialUser();
    emit("tool.user_requested", "user-tool-request", {
      arguments: { path: "a" },
      toolCallId: "user-call",
      toolName: "read",
    });
    emitEphemeral(session, "tool.execution_complete", "ephemeral-user-tool-result", {
      result: { content: "partial" },
      success: true,
      toolCallId: "user-call",
    });
    emitToolSuccess(session, "durable-user-tool-result", "user-call");
    await journal.barrier("user-requested completion");

    expect(await readRows(target)).toHaveLength(1);
    expect(journal.snapshot()).toMatchObject({ replayInvalid: true });
  });

  it("hides autopilot users while preserving unknown SDK source provenance", async () => {
    installMessageHook((message) => {
      const replacement = { ...message };
      delete (replacement as { display?: boolean }).display;
      return { message: replacement };
    });
    const { journal, emit, target } = await createInitializedFixture();
    emit("user.message", "autopilot-user", {
      content: "continue",
      attachments: [
        { type: "file", displayName: "notes.txt", mimeType: "text/plain", path: "/tmp/notes.txt" },
        { type: "blob", data: "c2VjcmV0LWJ5dGVz", displayName: "image.png", mimeType: "image/png" },
      ],
      isAutopilotContinuation: true,
      source: "future-source-kind",
    });
    emit("tool.execution_complete", "user-tool-result", {
      isUserRequested: true,
      result: { content: "user tool result" },
      success: true,
      toolCallId: "user-call",
    });
    emit("user.message", "skill-user", { content: "injected skill context", source: "skill-pdf" });
    emit("user.message", "unknown-user", {
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
    emitToolTurn(session, "complete", "first", "done");
    await journal.barrier("complete group");
    emitAssistant(session, "assistant-open", {
      content: "second",
      toolRequests: [toolRequest("call-open")],
    });

    await expect(journal.barrier("abort")).rejects.toMatchObject({
      code: "transcript_persistence_failed",
    });
    const rows = await readRows(target);
    expect(rows.map((row) => row.message.role)).toEqual(["user", "assistant", "toolResult"]);
  });

  it("suppresses the complete group when one message is authoritatively blocked", async () => {
    installMessageHook((message) => (message.role === "toolResult" ? { block: true } : undefined));
    const { journal, session, target } = await createInitializedFixture();
    emitToolTurn(session, "blocked", "checking", "secret");
    await journal.barrier("blocked group");

    const rows = await readRows(target);
    expect(rows.map((row) => row.message.role)).toEqual(["user"]);
    expect(journal.snapshot()).toMatchObject({
      assistantTranscriptOwned: true,
      replayInvalid: true,
    });
  });

  it("does not rerun group hooks for an idempotent replay", async () => {
    const hook = vi.fn(() => undefined);
    installJournalMessageWriteHook(hook);
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

  it("rejects a partial persisted tool group before running group hooks", async () => {
    const { journal, session, target } = await createInitializedFixture();
    await appendSessionTranscriptMessageByIdentity({
      ...target,
      eventId: "assistant-replay",
      message: {
        role: "assistant",
        content: [],
        idempotencyKey: "copilot-sdk:sdk-session:assistant-replay",
      },
    });
    const hook = vi.fn(() => undefined);
    installJournalMessageWriteHook(hook);
    emitReplayGroup(session);
    await expect(journal.barrier("partial group")).rejects.toThrow("partial persisted tool group");
    expect(hook).not.toHaveBeenCalled();
    expect(await readRows(target)).toHaveLength(2);
  });
});

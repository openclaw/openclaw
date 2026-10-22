import { Buffer } from "node:buffer";
import fs from "node:fs/promises";
import path from "node:path";
import {
  embeddedAgentLog,
  type AgentMessage,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  castAgentMessage,
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fixture from "./event-projector.compact.test-support.js";
import { CodexAppServerEventProjector } from "./event-projector.js";
import {
  createParams as createProjectorParams,
  forCurrentTurn,
  registerCodexEventProjectorTestLifecycle,
} from "./event-projector.test-harness.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import type { CodexThread, CodexThreadItem, CodexTurn } from "./protocol.js";
import { readCodexMirroredSessionHistoryMessages } from "./session-history.js";
import {
  projectBoundedCodexThreadHistory,
  projectBoundedCodexVisibleSessionHistory,
} from "./transcript-history-projection.js";
import {
  codexTranscriptMirrorRuntime,
  importCodexThreadHistoryToTranscript,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";
import {
  createTranscriptMirrorTestHarness,
  readMirrorMessages,
  readMirrorRaw,
} from "./transcript-mirror.test-harness.js";
import {
  attachCodexAssistantItemIds,
  attachCodexMirrorIdentity,
} from "./upstream-prompt-provenance.js";
import { buildCodexUserPromptMessage } from "./user-prompt-message.js";

const mirrorTranscript = codexTranscriptMirrorRuntime.mirror;
const mirrorBestEffort = codexTranscriptMirrorRuntime.mirrorBestEffort;

const publishTranscript = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: publishTranscript,
  };
});

const { makeRoot, createSqliteMirrorTarget: createTarget } = createTranscriptMirrorTestHarness();
type MirrorTarget = Awaited<ReturnType<typeof createTarget>>;
type BestEffortOptions = Parameters<typeof mirrorBestEffort>[0];

function settlementOptionsForPrompt(params: EmbeddedRunAttemptParams) {
  return {
    params,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    notifyUserMessagePersisted: () => undefined,
    cwd: params.workspaceDir,
    threadId: "thread-1",
    turnId: "turn-1",
  };
}

function settle(
  params: EmbeddedRunAttemptParams,
  result: BestEffortOptions["result"],
  overrides: Partial<BestEffortOptions> = {},
) {
  return mirrorBestEffort({
    ...settlementOptionsForPrompt(params),
    result,
    ...overrides,
  });
}

function beforeMessageWrite(handler: (...args: unknown[]) => unknown) {
  initializeGlobalHookRunner(
    createMockPluginRegistry([{ hookName: "before_message_write", handler }]),
  );
}

function mirrorMessages(target: MirrorTarget, messages: AgentMessage[], thread = "thread-1") {
  return mirrorTranscript({
    ...target,
    messages,
    idempotencyScope: `codex-app-server:${thread}`,
  });
}

const publication = (update: unknown) =>
  expect.objectContaining({ update: expect.objectContaining(update) });

async function projectorParams(
  target: MirrorTarget,
  fields: Partial<EmbeddedRunAttemptParams> = {},
) {
  return {
    ...(await createProjectorParams()),
    ...target,
    sessionTarget: target,
    workspaceDir: path.dirname(target.storePath),
    ...fields,
  };
}

afterEach(() => {
  resetGlobalHookRunner();
  publishTranscript.mockReset();
});

function mirroredUser(text: string, identity: string, timestamp = Date.now()) {
  return attachCodexMirrorIdentity(
    makeAgentUserMessage({ content: [{ type: "text", text }], timestamp }),
    identity,
  );
}

function mirroredAssistant(text: string, identity: string, timestamp = Date.now()) {
  return attachCodexMirrorIdentity(
    makeAgentAssistantMessage({ content: [{ type: "text", text }], timestamp }),
    identity,
  );
}

function row(role: "user" | "assistant", text: string) {
  return { role, text };
}

function assistantContent(text: string) {
  return { role: "assistant", content: fixture.text(text) };
}

async function readTranscriptMessages(target: MirrorTarget) {
  return (await readSessionTranscriptEvents(target)).flatMap((event) => {
    const entry = asOptionalRecord(event);
    return entry?.type === "message" ? [entry.message] : [];
  });
}

function snapshot(messagesSnapshot: AgentMessage[]) {
  return { messagesSnapshot } as BestEffortOptions["result"];
}

function settleSnapshot(target: MirrorTarget, messages: AgentMessage[]) {
  return settle(
    {
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      suppressNextUserMessagePersistence: true,
    } as unknown as EmbeddedRunAttemptParams,
    snapshot(messages),
    {
      agentId: target.agentId,
      cwd: target.storePath,
    },
  );
}

describe("buildCodexUserPromptMessage", () => {
  it("uses transcriptPrompt when an embedded caller does not provide a recorder", () => {
    const message = buildCodexUserPromptMessage({
      prompt:
        "[Audible call-opening context]\nAssistant: Welcome.\n[End audible call-opening context]\n\nCurrent caller message:\nHello",
      transcriptPrompt: "Hello",
      messageProvider: "voice",
      inputProvenance: { kind: "external_user", sourceChannel: "voice" },
    } as unknown as Parameters<typeof buildCodexUserPromptMessage>[0]);

    expect(message).toMatchObject({
      role: "user",
      content: "Hello",
      sourceChannel: "voice",
      provenance: { kind: "external_user", sourceChannel: "voice" },
    });
  });
});

describe("mirrorTranscript", () => {
  it("hides current memory-maintenance messages without hiding replayed turns", async () => {
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => message);
    beforeMessageWrite((event) => {
      const { display: _display, ...message } = (event as { message: Record<string, unknown> })
        .message;
      return { message: castAgentMessage({ ...message, display: true }) };
    });
    const target = await createTarget("openclaw-codex-mirror-memory-");
    const messages = [
      mirroredAssistant("ordinary prior reply", "turn-prior:assistant", Date.now()),
      mirroredUser("Pre-compaction memory flush", "turn-memory:prompt", Date.now() + 1),
      attachCodexMirrorIdentity(
        makeAgentAssistantMessage({
          content: [{ type: "toolCall", id: "call-1", name: "write", arguments: {} }],
          timestamp: Date.now() + 2,
        }),
        "turn-memory:tool-call:call-1",
      ),
      attachCodexMirrorIdentity(
        castAgentMessage({
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "write",
          content: [{ type: "toolResult", toolCallId: "call-1", content: "saved" }],
          timestamp: Date.now() + 3,
        }),
        "turn-memory:tool-result:call-1",
      ),
      mirroredAssistant("NO_REPLY", "turn-memory:assistant", Date.now() + 4),
    ];
    for (const message of messages.slice(1)) {
      Object.assign(message, { display: false });
    }

    await mirrorTranscript({
      ...target,
      messages,
      idempotencyScope: "codex-app-server:memory",
      runId: "run-memory",
      terminalAssistantOwner: { mirrorIdentity: "turn-memory:assistant", runId: "run-memory" },
      prepareAssistantTranscriptMessage,
    });

    const persistedMessages = await readTranscriptMessages(target);
    expect(persistedMessages).toHaveLength(messages.length);
    expect(persistedMessages[0]).not.toHaveProperty("display", false);
    expect(
      persistedMessages.slice(1).every((message) => asOptionalRecord(message)?.display === false),
    ).toBe(true);
    expect(prepareAssistantTranscriptMessage).not.toHaveBeenCalled();
  });

  it("preserves mirror identity across redaction from prompt append through final snapshot", async () => {
    const target = await createTarget("openclaw-codex-mirror-redacted-identity-");
    const config = { logging: { redactPatterns: [String.raw`^codex-app-server:.*$`] } };
    const userMessage = mirroredUser("client prompt", "turn-1:prompt", Date.now());
    const assistantMessage = mirroredAssistant("final answer", "turn-1:assistant", Date.now() + 1);
    const mirrorParams = {
      ...target,
      idempotencyScope: "codex-app-server:thread-1",
      config,
    };

    await mirrorTranscript({ ...mirrorParams, messages: [userMessage] });
    const finalMirror = await mirrorTranscript({
      ...mirrorParams,
      messages: [userMessage, assistantMessage],
    });

    expect(finalMirror.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await readMirrorMessages(target)).toEqual([
      row("user", "client prompt"),
      row("assistant", "final answer"),
    ]);
    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"idempotencyKey":"codex-app-server:thread-1:turn-1:prompt"');
    expect(raw).toContain('"idempotencyKey":"codex-app-server:thread-1:turn-1:assistant"');
  });

  it("prepares only the owned terminal media row before persistence and publication", async () => {
    const target = await createTarget("openclaw-codex-mirror-media-owner-");
    const sourceText = "Artifacts ready\nMEDIA:./artifact.json";
    const rewrittenText = `${sourceText}\nMEDIA:./hook-only.json`;
    const prepareAssistantTranscriptMessage = vi.fn((message: AssistantMessage) => ({
      ...message,
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
    }));
    const writeHook = vi.fn((input: unknown) => {
      const message = (input as { message: AgentMessage }).message;
      return message.role === "assistant" &&
        message.content.some((part) => part.type === "text" && part.text === sourceText)
        ? {
            message: {
              ...message,
              idempotencyKey: "hook-rewritten-key",
              content: [{ type: "text", text: rewrittenText }],
            },
          }
        : undefined;
    });
    beforeMessageWrite(writeHook);
    const messages = [
      attachCodexMirrorIdentity(makeAgentUserMessage({ content: sourceText }), "turn-1:prompt"),
      ...[
        "turn-0:assistant",
        "turn-1:commentary:item",
        "turn-1:async:item",
        "turn-1:assistant",
      ].map((identity) =>
        attachCodexMirrorIdentity(
          makeAgentAssistantMessage({
            content: [
              {
                type: "text",
                text: identity === "turn-1:assistant" ? sourceText : "MEDIA:./unowned.json",
              },
            ],
          }),
          identity,
        ),
      ),
    ];
    await settle(
      {
        ...target,
        sessionTarget: target,
        runId: "run-media",
        prepareAssistantTranscriptMessage,
      } as unknown as EmbeddedRunAttemptParams,
      snapshot(messages),
      { cwd: path.dirname(target.storePath) },
    );

    expect(writeHook).toHaveBeenCalledTimes(5);
    expect(prepareAssistantTranscriptMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ content: [{ type: "text", text: rewrittenText }] }),
      sourceText,
    );
    const published = publishTranscript.mock.calls.map(([params]) => params.update.message);
    expect(published).toHaveLength(5);
    expect(published.slice(0, -1)).toEqual(
      messages
        .slice(0, -1)
        .map((message) =>
          expect.objectContaining({ role: message.role, content: message.content }),
        ),
    );
    expect(published.slice(0, -1).some((message) => message.openclawDelivery)).toBe(false);
    expect(published.at(-1)).toMatchObject({
      content: [{ type: "text", text: rewrittenText }],
      openclawDelivery: { mediaUrls: ["./artifact.json"] },
      idempotencyKey: "codex-app-server:thread-1:turn-1:assistant",
    });
    expect(await readTranscriptMessages(target)).toEqual(published);
  });

  it("keeps assistant ownership when live update publication fails", async () => {
    publishTranscript.mockRejectedValueOnce(new Error("publish failed"));
    const target = await createTarget("openclaw-codex-mirror-publish-failure-");
    const assistantMessage = mirroredAssistant("durably persisted", "turn-1:assistant", Date.now());

    const result = await mirrorMessages(target, [assistantMessage]);

    expect(result.assistantMirrorIdentitiesOwned).toEqual(["turn-1:assistant"]);
    expect(await readMirrorRaw(target)).toContain('"role":"assistant"');
  });

  it("rejects mirror writes without a runtime session identity", async () => {
    await expect(
      mirrorTranscript({
        sessionId: "session-1",
        messages: [
          makeAgentAssistantMessage({
            content: fixture.text("no identity"),
            timestamp: Date.now(),
          }),
        ],
      }),
    ).rejects.toThrow("runtime session identity");
  });

  it("serializes concurrent mirrors with the same supplied identity", async () => {
    const target = await createTarget("openclaw-codex-mirror-concurrent-");
    const message = mirroredUser("append once", "turn-1:prompt", Date.now());

    const results = await Promise.all([
      mirrorMessages(target, [message]),
      mirrorMessages(target, [message]),
    ]);

    expect((await readMirrorMessages(target)).filter((entry) => entry.role)).toEqual([
      row("user", "append once"),
    ]);
    expect(results.map((result) => result.userMessageReceipts[0]?.message.content)).toEqual([
      [{ type: "text", text: "append once" }],
      [{ type: "text", text: "append once" }],
    ]);
  });

  it.each(["in-place", "forge"] as const)(
    "sender provenance in Codex mirrors rejects hook reassignment: %s",
    async (mode) => {
      beforeMessageWrite((event) => {
        const message = (event as { message: { __openclaw: Record<string, unknown> } }).message;
        if (mode === "in-place") {
          (message["__openclaw"].senderIdentity as { id: string }).id = "forged";
        }
        if (mode === "forge") {
          message["__openclaw"].senderIdentity = { type: "profile", id: "forged" };
        }
      });
      const target = await createTarget("sender-provenance-mirror-");
      await mirrorTranscript({
        ...target,
        idempotencyScope: "scope",
        messages: [
          castAgentMessage({
            role: "user",
            content: "hello",
            timestamp: 1,
            __openclaw: {
              senderId: "author",
              ...(mode === "forge" ? {} : { senderIdentity: { type: "profile", id: "author" } }),
            },
          }),
        ],
      });
      const messages = (await readTranscriptMessages(target)).filter(
        (message) => asOptionalRecord(message)?.role === "user",
      );
      expect(
        messages.map(
          (message) => asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.senderIdentity,
        ),
      ).toEqual([undefined]);
    },
  );

  it("skips transcript mirrors for sessionless embedded runs", async () => {
    const root = makeRoot("openclaw-codex-transcript-failure-");
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    const markRuntimePersistencePending = vi.fn();
    const assistantMessage = mirroredAssistant(
      "needs fallback persistence",
      "turn-1:assistant",
      Date.now(),
    );

    const params = {
      prompt: "sessionless prompt",
      runId: "probe-setup-inference-sessionless",
      sessionId: "session-1",
      userTurnTranscriptRecorder: {
        markRuntimePersistencePending,
        resolveMessage: async () => undefined,
      },
    } as unknown as Parameters<typeof mirrorBestEffort>[0]["params"];

    await mirrorPromptAtTurnStartBestEffort({
      params,
      sessionKey: "agent:main:setup-inference:incognito-session-1",
      notifyUserMessagePersisted: () => undefined,
      cwd: root,
      threadId: "thread-1",
      turnId: "turn-1",
      upstreamUserText: "sessionless prompt",
    });
    const mirrorOutcome = await settle(params, snapshot([assistantMessage]), {
      sessionKey: "agent:main:setup-inference:incognito-session-1",
      cwd: root,
    });

    expect(mirrorOutcome).toEqual({ assistantTranscriptOwned: false, mirroredMessages: [] });
    expect(markRuntimePersistencePending).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("renders normal-session mirror failures in structured warnings", async () => {
    const root = makeRoot("openclaw-codex-transcript-failure-");
    const blockedParent = path.join(root, "not-a-directory");
    await fs.writeFile(blockedParent, "blocked");
    const storePath = path.join(blockedParent, "openclaw-agent.sqlite");
    const warn = vi.spyOn(embeddedAgentLog, "warn").mockImplementation(() => undefined);
    warn.mockClear();
    const runId = "run-1";
    const sessionId = "session-1";
    const params = {
      prompt: "persist me",
      runId,
      sessionId,
      sessionTarget: { storePath },
      hostCapabilities: createCodexTestHostCapabilities(),
    } as unknown as Parameters<typeof mirrorPromptAtTurnStartBestEffort>[0]["params"];

    await mirrorPromptAtTurnStartBestEffort({
      params,
      sessionKey: "agent:main:session-1",
      notifyUserMessagePersisted: () => undefined,
      cwd: storePath,
      threadId: "thread-1",
      turnId: "turn-1",
      upstreamUserText: "persist me",
    });

    expect(warn).toHaveBeenCalledWith("failed to mirror codex app-server prompt at turn start", {
      error: expect.stringContaining(blockedParent),
      runId,
      sessionId,
    });

    warn.mockClear();
    await settle(
      params,
      snapshot([
        makeAgentAssistantMessage({
          content: fixture.text("persist me too"),
          timestamp: Date.now(),
        }),
      ]),
      {
        sessionKey: "agent:main:session-1",
        cwd: root,
      },
    );
    expect(warn).toHaveBeenCalledWith("failed to mirror codex app-server transcript", {
      error: expect.stringContaining(blockedParent),
      runId,
      sessionId,
    });
  });

  it.each(["stale idempotency hit", "hook-transformed payload"] as const)(
    "attests only the matching persisted source: %s",
    async (scenario) => {
      const stale = scenario === "stale idempotency hit";
      const target = await createTarget("codex-attestation-");
      if (stale) {
        await mirrorMessages(target, [
          mirroredAssistant("stale answer", "turn-1:assistant", Date.now()),
        ]);
        publishTranscript.mockClear();
      } else {
        beforeMessageWrite(() => ({
          message: castAgentMessage(assistantContent("[redacted by hook]")),
        }));
      }
      const source = attachCodexAssistantItemIds(
        mirroredAssistant(stale ? "current answer" : "sensitive answer", "turn-1:assistant"),
        [stale ? "current-item" : "rewritten-item"],
      );
      const outcome = await settleSnapshot(target, [source]);
      expect(outcome.assistantTranscriptOwned).toBe(!stale);
      if (stale) {
        expect(outcome.mirroredMessages).toEqual([]);
        expect(publishTranscript).not.toHaveBeenCalled();
      } else {
        expect(outcome.assistantTranscriptIdempotencyKey).toBe(
          "codex-app-server:thread-1:turn-1:assistant",
        );
        expect(outcome.mirroredMessages).toMatchObject([assistantContent("[redacted by hook]")]);
        expect(JSON.stringify(outcome.mirroredMessages)).not.toContain("sensitive answer");
        expect(publishTranscript).toHaveBeenCalledWith(
          publication({ assistantItemIds: ["rewritten-item"] }),
        );
      }
    },
  );

  describe("projected transcript persistence", () => {
    registerCodexEventProjectorTestLifecycle();

    it.each([false, true])(
      "freezes receipt occurrences before continuation arrives (retry=%s)",
      async (retry) => {
        const target = await createTarget("openclaw-codex-captured-occurrence-");
        const onAgentEvent = vi.fn<NonNullable<EmbeddedRunAttemptParams["onAgentEvent"]>>();
        const onPartialReply = vi.fn<NonNullable<EmbeddedRunAttemptParams["onPartialReply"]>>();
        const params = await projectorParams(target, {
          suppressNextUserMessagePersistence: true,
          onAgentEvent,
          onPartialReply,
        });
        const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
        const item = fixture.finalMessage("answer");
        const delta = (text: string) => fixture.delta(projector, text, item.id);
        const events = () =>
          onAgentEvent.mock.calls.flatMap(([event]) =>
            event.stream === "assistant" ? [event.data] : [],
          );
        const mirrorParams = {
          ...target,
          idempotencyScope: "codex-app-server:thread-1",
          runId: params.runId,
          runMirrorIdentityPrefix: "turn-1:",
          onAssistantMessageOwned: (identity: string) =>
            projector.markSteeringTranscriptMessagePersisted(identity),
        };
        await fixture.start(projector, item);
        await delta("A");
        let captured = projector.buildSteeringTranscriptPrefix();
        if (retry) {
          await expect(
            mirrorTranscript({
              ...mirrorParams,
              messages: captured,
              assertCurrent: () => {
                throw new Error("write owner unavailable");
              },
            }),
          ).rejects.toThrow("write owner unavailable");
        }
        // Capture precedes the awaited append; the receipt must not acquire these bytes.
        await delta("B");
        const [first, second] = events().map((event) => event.occurrenceId);
        expect(first).toEqual(expect.any(String));
        expect(second).toEqual(expect.any(String));
        expect(second).not.toBe(first);
        if (retry) {
          captured = projector.buildSteeringTranscriptPrefix();
        }
        const capturedIds = retry ? [first, second] : [first];
        await mirrorTranscript({ ...mirrorParams, messages: captured });
        expect(publishTranscript).toHaveBeenLastCalledWith(
          publication({ assistantItemIds: capturedIds }),
        );
        publishTranscript.mockClear();
        await mirrorTranscript({ ...mirrorParams, messages: captured });
        expect(publishTranscript).toHaveBeenCalledOnce();
        expect(publishTranscript).toHaveBeenLastCalledWith(
          publication({ assistantItemIds: capturedIds }),
        );
        await delta("C");
        if (retry) {
          expect(events()[2]?.occurrenceId).not.toBe(first);
          expect(events()[2]?.occurrenceId).not.toBe(second);
        } else {
          expect(events()[2]?.occurrenceId).toBe(second);
        }
        expect(
          events().map(({ itemId, text, delta: chunk }) => ({ itemId, text, delta: chunk })),
        ).toEqual([
          { itemId: "answer", text: "A", delta: "A" },
          { itemId: "answer", text: "AB", delta: "B" },
          { itemId: "answer", text: "ABC", delta: "C" },
        ]);
        expect(onPartialReply.mock.calls.map(([payload]) => payload)).toEqual([
          { text: "A", delta: "A" },
          { text: "AB", delta: "B" },
          { text: "ABC", delta: "C" },
        ]);
        await fixture.finish(projector, [{ ...item, text: "ABC" }]);
        await settle(params, fixture.result(projector));
        expect(publishTranscript).toHaveBeenLastCalledWith(
          publication({
            assistantItemIds: [...new Set(events().map((event) => event.occurrenceId))],
            message: expect.objectContaining({
              content: [{ type: "text", text: retry ? "C" : "BC" }],
            }),
          }),
        );
        expect(await readMirrorMessages(target)).toEqual([
          { role: "assistant", text: retry ? "AB" : "A" },
          { role: "assistant", text: retry ? "C" : "BC" },
        ]);
        const durable = await readMirrorRaw(target);
        expect(durable).not.toContain("assistantItemIds");
        expect(durable).not.toContain("occurrenceId");
      },
    );

    it("retains each committed steering cutoff when a later mirror assertion fails", async () => {
      const target = await createTarget("openclaw-codex-steering-partial-mirror-");
      const params: EmbeddedRunAttemptParams = {
        ...(await createProjectorParams()),
        ...target,
        suppressNextUserMessagePersistence: true,
      };
      const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
      const item = fixture.finalMessage("answer");
      await fixture.start(projector, item);
      await fixture.delta(projector, "Before failed mirror.", item.id);
      const firstPrefix = projector.buildSteeringTranscriptPrefix();
      const owned: string[] = [];
      let failed = false;
      const mirrorOptions = {
        ...target,
        idempotencyScope: "codex-app-server:thread-1",
        onAssistantMessageOwned: (identity: string) => {
          projector.markSteeringTranscriptMessagePersisted(identity);
          owned.push(identity);
        },
        assertCurrent: () => {
          if (owned.length > 0 && !failed) {
            failed = true;
            throw new Error("owner changed after first commit");
          }
        },
      };
      await expect(
        mirrorTranscript({
          ...mirrorOptions,
          messages: [...firstPrefix, mirroredAssistant("Uncommitted later row", "turn-1:later", 2)],
        }),
      ).rejects.toThrow("owner changed after first commit");
      expect(await readMirrorMessages(target)).toEqual([row("assistant", "Before failed mirror.")]);

      await fixture.delta(projector, " After failed mirror.", item.id);
      const secondPrefix = projector.buildSteeringTranscriptPrefix();
      await mirrorTranscript({
        ...mirrorOptions,
        messages: [...firstPrefix, ...secondPrefix, mirroredUser("Steer", "steer:user", 3)],
      });
      expect(owned).toEqual([
        "turn-1:assistant:answer:segment:0",
        "turn-1:assistant:answer:segment:0",
        "turn-1:assistant:answer:segment:1",
      ]);
      const completed = {
        ...item,
        text: "Before failed mirror. After failed mirror. After steer.",
      };
      await fixture.complete(projector, completed);
      await fixture.finish(projector, [completed]);
      await mirrorTranscript({
        ...mirrorOptions,
        messages: fixture.result(projector).messagesSnapshot,
      });
      expect(await readMirrorMessages(target)).toEqual([
        row("assistant", "Before failed mirror."),
        row("assistant", " After failed mirror."),
        row("user", "Steer"),
        row("assistant", " After steer."),
      ]);
    });

    it("keeps failed attempt diagnostics without taking deferred run ownership", async () => {
      const target = await createTarget("openclaw-codex-mirror-retry-owner-");
      const params = await projectorParams(target, {
        suppressNextUserMessagePersistence: true,
        deferTerminalLifecycle: true,
      });
      const finalRunId = params.runId;
      const attempts = [
        { turnId: "turn-1", runId: params.runId, failed: true, text: "The file is ready." },
        {
          turnId: "turn-2",
          runId: finalRunId,
          failed: false,
          text: "The action completed once.",
        },
      ];
      for (const attempt of attempts) {
        const attemptParams = { ...params, runId: attempt.runId };
        const projector = new CodexAppServerEventProjector(
          attemptParams,
          "thread-1",
          attempt.turnId,
        );
        await projector.handleNotification(
          forCurrentTurn("turn/completed", {
            turnId: attempt.turnId,
            turn: {
              id: attempt.turnId,
              status: attempt.failed ? "failed" : "completed",
              items: [{ type: "agentMessage", id: `answer-${attempt.turnId}`, text: attempt.text }],
              error: attempt.failed
                ? { message: "Rate limit reached", codexErrorInfo: "rateLimitExceeded" }
                : null,
            },
          }),
        );
        await settle(attemptParams, fixture.result(projector), {
          turnId: attempt.turnId,
        });
      }

      const messages = await readCodexMirroredSessionHistoryMessages({
        ...params,
        sessionFile: target.bogusSessionFile,
      });
      expect(messages).toHaveLength(2);
      expect(messages).toMatchObject([
        {
          content: fixture.text("The file is ready."),
          stopReason: "error",
          errorMessage: expect.stringContaining("Rate limit reached"),
          __openclaw: { mirrorIdentity: "turn-1:assistant", runId: params.runId },
        },
        {
          content: fixture.text("The action completed once."),
          stopReason: "stop",
          __openclaw: {
            mirrorIdentity: "turn-2:assistant",
            runId: finalRunId,
            runTerminal: true,
          },
        },
      ]);
      expect(messages?.[0]).not.toHaveProperty("__openclaw.runTerminal");
      expect(publishTranscript.mock.calls[0]?.[0].update).not.toHaveProperty("runId");
      expect(publishTranscript.mock.calls[1]?.[0].update).toHaveProperty("runId", finalRunId);
    });

    it("preserves reasoning as nonterminal thinking beside the final answer in SQLite", async () => {
      const target = await createTarget("openclaw-codex-mirror-reasoning-");
      const params = await projectorParams(target);
      const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
      await fixture.notify(projector, "item/reasoning/summaryTextDelta", {
        itemId: "reason-1",
        summaryIndex: 0,
        delta: "checking the answer",
      });
      await fixture.finish(projector, [fixture.finalMessage("answer-1", "hi there")]);
      const result = fixture.result(projector);
      expect(result.assistantTexts).toEqual(["hi there"]);

      const mirrored = await settle(params, result);

      expect(mirrored.assistantTranscriptOwned).toBe(true);
      const messages = await readCodexMirroredSessionHistoryMessages({
        ...params,
        sessionFile: target.bogusSessionFile,
      });
      expect(messages).toMatchObject([
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: [{ type: "thinking", thinking: "checking the answer" }],
          __openclaw: { mirrorIdentity: "turn-1:reasoning", runId: "run-1" },
        },
        {
          role: "assistant",
          content: fixture.text("hi there"),
          __openclaw: { mirrorIdentity: "turn-1:assistant", runTerminal: true },
        },
      ]);
      expect(messages?.[1]).not.toHaveProperty("__openclaw.runTerminal");
    });
  });

  it("dedupes mirrored messages despite snapshot positional shifts", async () => {
    const target = await createTarget("openclaw-codex-mirror-shift-");
    const userMessage = mirroredUser("hello", "turn-1:prompt", Date.now());
    const assistantMessage = mirroredAssistant("hi there", "turn-1:assistant", Date.now() + 1);

    await mirrorMessages(target, [userMessage, assistantMessage], "thread-X");
    const reasoningMessage = attachCodexMirrorIdentity(
      makeAgentAssistantMessage({
        content: [{ type: "thinking", thinking: "thinking" }],
        timestamp: Date.now() + 2,
      }),
      "turn-1:reasoning",
    );
    await mirrorMessages(target, [userMessage, reasoningMessage, assistantMessage], "thread-X");

    expect((await readMirrorMessages(target)).map((m) => m.text)).toEqual([
      "hello",
      "hi there",
      undefined,
    ]);
  });

  it("keeps repeated same-content turns distinct", async () => {
    const target = await createTarget("openclaw-codex-mirror-repeat-");
    const userTurn1 = mirroredUser("yes", "turn-1:prompt", Date.now());
    const assistantTurn1 = mirroredAssistant("ok 1", "turn-1:assistant", Date.now() + 1);
    const userTurn2 = mirroredUser("yes", "turn-2:prompt", Date.now() + 2);
    const assistantTurn2 = mirroredAssistant("ok 2", "turn-2:assistant", Date.now() + 3);

    await mirrorMessages(target, [userTurn1, assistantTurn1], "thread-X");
    await mirrorMessages(target, [userTurn2, assistantTurn2], "thread-X");

    expect(await readMirrorMessages(target)).toEqual([
      row("user", "yes"),
      row("assistant", "ok 1"),
      row("user", "yes"),
      row("assistant", "ok 2"),
    ]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

const deliverAsyncMessageBestEffort = codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort;

async function createDelivery(
  itemId: string,
  text: string,
  onBlockReply = vi.fn(),
  message?: AgentMessage,
) {
  const target = await createTarget(`openclaw-codex-mirror-${itemId}-`);
  const cwd = path.dirname(target.storePath);
  const params = {
    agentId: target.agentId,
    sessionId: target.sessionId,
    sessionKey: target.sessionKey,
    sessionTarget: target,
    workspaceDir: cwd,
    runId: `run-${itemId}`,
    onBlockReply,
  } as unknown as EmbeddedRunAttemptParams;
  return {
    target,
    onBlockReply,
    delivery: {
      cwd,
      params,
      itemId,
      text,
      message:
        message ??
        castAgentMessage({
          ...makeAgentAssistantMessage({
            content: [{ type: "text", text }],
            timestamp: Date.now(),
          }),
          openclawAsyncDelivery: { itemId },
        }),
      threadId: "thread-1",
      turnId: "turn-1",
    },
  };
}

describe("deliverAsyncMessageBestEffort", () => {
  it("delivers the persisted async rewrite once across reconnect replay", async () => {
    beforeMessageWrite((event) => {
      const message = asOptionalRecord(asOptionalRecord(event)?.message);
      expect(message).toHaveProperty("openclawAsyncDelivery.questions");
      const firstBlock = asOptionalRecord(
        Array.isArray(message?.content) ? message.content[0] : undefined,
      );
      if (!firstBlock) {
        throw new Error("Expected the async question text block");
      }
      firstBlock.text = "[redacted async update]";
      return {
        message: castAgentMessage({
          ...message,
          phase: "final_answer",
        }),
      };
    });
    const message = castAgentMessage({
      ...makeAgentAssistantMessage({
        content: fixture.text("Sensitive background update."),
        timestamp: Date.now(),
      }),
      phase: "final_answer",
      openclawAsyncDelivery: {
        itemId: "async-update",
        questions: [{ title: "Sensitive question?", options: ["Sensitive choice"] }],
      },
    });
    const { target, delivery, onBlockReply } = await createDelivery(
      "async-update",
      "Sensitive background update.",
      vi.fn(),
      message,
    );

    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("settled");
    await expect(
      deliverAsyncMessageBestEffort({
        ...delivery,
        params: { ...delivery.params, runId: "run-async-reconnect" },
      }),
    ).resolves.toBe("settled");

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenNthCalledWith(
      1,
      { text: "[redacted async update]" },
      {
        deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:async-update",
      },
    );
    expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
    expect(onBlockReply.mock.calls.map(([payload]) => payload)).not.toContainEqual({
      text: "Sensitive background update.",
    });
    expect(await readMirrorMessages(target)).toEqual([row("assistant", "[redacted async update]")]);
    const updates = publishTranscript.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update?.message).toMatchObject({
      role: "assistant",
      content: fixture.text("[redacted async update]"),
      phase: "final_answer",
      idempotencyKey: "codex-app-server:thread-1:turn-1:async:async-update",
      openclawAsyncDelivery: { itemId: "async-update" },
      __openclaw: { runId: "run-async-update" },
    });
    expect(updates[0]?.update?.message).not.toHaveProperty("openclawAsyncDelivery.questions");
    expect(updates[0]?.update?.message).not.toHaveProperty("__openclaw.runTerminal");
    const persisted = await readMirrorRaw(target);
    expect(persisted).toContain('"runId":"run-async-update"');
    expect(persisted).not.toContain('"runId":"run-async-reconnect"');
  });

  it("retries a durable async callback from the persisted row", async () => {
    const onBlockReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("channel unavailable"))
      .mockResolvedValue(undefined);
    const { target, delivery } = await createDelivery(
      "async-callback-fail",
      "Persisted background update.",
      onBlockReply,
    );

    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("retry");
    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("settled");

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
    expect(onBlockReply).toHaveBeenCalledWith(
      { text: "Persisted background update." },
      {
        deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:async-callback-fail",
      },
    );
    expect(await readMirrorMessages(target)).toEqual([
      row("assistant", "Persisted background update."),
    ]);
    expect(publishTranscript).toHaveBeenCalledOnce();
  });

  it("does not deliver async messages blocked by before_message_write", async () => {
    beforeMessageWrite(() => ({ block: true }));
    const { target, delivery, onBlockReply } = await createDelivery(
      "async-blocked",
      "Blocked update.",
    );
    delivery.message = attachCodexAssistantItemIds(delivery.message, ["blocked-item"]);
    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("settled");

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(await readMirrorMessages(target)).toEqual([]);
    expect(publishTranscript).not.toHaveBeenCalled();
  });
});

describe("coordination transcript visibility", () => {
  registerCodexEventProjectorTestLifecycle();
  it.each([
    { sourceTool: "sessions_send", hidden: true },
    { sourceTool: "subagent_settle", privateCompletion: true as const, hidden: true },
    { sourceTool: "subagent_settle", hidden: false },
  ])(
    "keeps $sourceTool work in SQLite (private=$privateCompletion)",
    async ({ sourceTool, hidden, privateCompletion }) => {
      const target = await createTarget("codex-coordination-");
      const params = await projectorParams(target, {
        prompt: "Review the worker result",
        privateCompletion,
        inputProvenance: { kind: "inter_session", sourceTool, sourceRole: "subagent" },
      });
      const expectHistory = async (entries: [string, string][]) => {
        const messages = await readCodexMirroredSessionHistoryMessages({
          ...params,
          sessionFile: target.bogusSessionFile,
        });
        expect(messages).toHaveLength(entries.length);
        expect(messages).toMatchObject(
          entries.map(([role, text]) => ({
            role,
            content: role === "user" ? text : fixture.text(text),
          })),
        );
        expect(messages?.map((entry) => Reflect.get(entry, "display") === false)).toEqual(
          entries.map(() => hidden),
        );
      };
      beforeMessageWrite((event) => ({
        message: castAgentMessage({
          ...(event as { message: Record<string, unknown> }).message,
          display: true,
        }),
      }));
      await mirrorPromptAtTurnStartBestEffort({
        ...settlementOptionsForPrompt(params),
        upstreamUserText: params.prompt,
      });
      const projector = new CodexAppServerEventProjector(params, "thread-1", "turn-1");
      await fixture.complete(projector, fixture.message("progress", "progress", "commentary"));
      await expectHistory([
        ["user", params.prompt],
        ["assistant", "progress"],
      ]);
      await fixture.finish(projector, [fixture.finalMessage("answer", "answer")]);
      await settle(params, fixture.result(projector));
      await expectHistory([
        ["user", params.prompt],
        ["assistant", "progress"],
        ["assistant", "answer"],
      ]);
    },
  );
});

function messageContent(message: AgentMessage | undefined) {
  if (!message || !("content" in message)) {
    throw new Error("expected transcript message content");
  }
  return message.content;
}

function historyItem(
  id: string,
  text: string,
  fields: Partial<CodexThreadItem> = {},
): CodexThreadItem {
  return {
    id,
    text,
    type: "agentMessage",
    title: null,
    status: null,
    name: null,
    tool: null,
    server: null,
    command: null,
    cwd: null,
    query: null,
    aggregatedOutput: null,
    changes: [],
    ...fields,
  };
}

function userItem(id: string, text: string): CodexThreadItem {
  return historyItem(id, "", { type: "userMessage", content: [{ type: "text", text }] });
}

function turn(id: string, items: CodexThreadItem[], fields: Partial<CodexTurn> = {}): CodexTurn {
  return { id, status: "completed", items, ...fields };
}

function exchange(id: string, label: string, phase?: string, fields: Partial<CodexTurn> = {}) {
  const items = [
    userItem(`user-${id}`, `${label} question`),
    historyItem(`assistant-${id}`, `${label} answer`, { phase }),
  ];
  return turn(id, items, fields);
}

function responseMessage(role: "user" | "assistant", text: string, phase?: string) {
  return {
    type: "message",
    role,
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    ...(phase ? { phase } : {}),
  };
}

function project(
  thread: CodexThread | CodexTurn[],
  throughTurnId = Array.isArray(thread) ? (thread.at(-1)?.id ?? null) : null,
  modelProvider?: string,
) {
  return projectBoundedCodexThreadHistory({
    thread: Array.isArray(thread)
      ? { id: "thread-prefix", projectId: null, turns: thread }
      : thread,
    throughTurnId,
    modelProvider,
    importedAt: 1_800_000_000_000,
  });
}

function refusal(detailedExplanation: string, fields = {}) {
  return {
    message: "The provider paused this request.",
    codexErrorInfo: "misalignmentPolicyViolation",
    misalignment: { detailedExplanation, ...fields },
  };
}

describe("projectBoundedCodexThreadHistory", () => {
  const thread: CodexThread = {
    id: "thread-prefix",
    projectId: null,
    createdAt: 1_700_000_000,
    turns: [
      exchange("turn-a", "First", "commentary", {
        startedAt: 1_700_000_001,
        completedAt: 1_700_000_002,
      }),
      exchange("turn-b", "Second", "final_answer", {
        startedAt: 1_700_000_003,
        completedAt: 1_700_000_004,
      }),
      turn("turn-active", [historyItem("active-secret", "active tail")], { status: "inProgress" }),
      turn("turn-failed", [historyItem("failed-secret", "failed tail")], { status: "failed" }),
    ],
  };

  it("uses one inclusive completed-turn prefix for transcript and Responses API projection", () => {
    const projection = project(thread, "turn-b", "native-provider");

    expect(projection.transcriptMessages.map(messageContent)).toEqual([
      "First question",
      [{ type: "text", text: "First answer" }],
      "Second question",
      [{ type: "text", text: "Second answer" }],
    ]);
    expect(projection.transcriptMessages[1]).toMatchObject({
      role: "assistant",
      api: "openai-chatgpt-responses",
      provider: "native-provider",
      model: "native-history",
    });
    expect(projection.responseItems).toEqual([
      responseMessage("user", "First question"),
      responseMessage("assistant", "First answer", "commentary"),
      responseMessage("user", "Second question"),
      responseMessage("assistant", "Second answer", "final_answer"),
    ]);
    expect(JSON.stringify(projection)).not.toContain("active tail");
    expect(JSON.stringify(projection)).not.toContain("failed tail");
  });

  it("preserves imported async and commentary ownership while keeping async messages out of model history", () => {
    const question = "Which environment should I use?";
    const questions = [{ title: question, options: ["Staging", "Local"] }];
    const projection = project([
      turn("turn-async-history", [
        userItem("user-async-history", "Investigate this"),
        historyItem("commentary-history", "Checking the deployment.", { phase: "commentary" }),
        historyItem("async-history", question, {
          phase: "final_answer",
          delivery: "async",
          questions,
        }),
        historyItem("final-history", "Deployment complete.", { phase: "final_answer" }),
      ]),
    ]);

    expect(projection.transcriptMessages).toHaveLength(4);
    expect(projection.transcriptMessages[1]).toMatchObject({ phase: "commentary" });
    expect(projection.transcriptMessages[2]).toMatchObject({
      phase: "final_answer",
      openclawAsyncDelivery: { itemId: "async-history", questions },
    });
    expect(JSON.stringify(projection.responseItems)).not.toContain(question);
    expect(projection.responseItems).toHaveLength(3);
    expect(
      projectBoundedCodexVisibleSessionHistory(
        projection.transcriptMessages.map((message, index) => ({
          entryId: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          seq: index,
          role: message.role,
          message,
        })),
      ),
    ).toEqual([
      responseMessage("user", "Investigate this"),
      responseMessage("assistant", "Checking the deployment.", "commentary"),
      responseMessage("assistant", "Deployment complete.", "final_answer"),
    ]);
  });

  it("accepts terminal boundaries", () => {
    for (const [status, stopReason] of [
      ["completed", "stop"],
      ["interrupted", "aborted"],
      ["failed", "error"],
    ] as const) {
      const projection = project([
        ...(thread.turns?.slice(0, 2) ?? []),
        exchange(`turn-${status}`, status, undefined, {
          status,
          ...(status === "failed" ? { error: { message: "provider disconnected" } } : {}),
        }),
      ]);
      expect(messageContent(projection.transcriptMessages.at(-2))).toBe(`${status} question`);
      const assistant = projection.transcriptMessages.at(-1);
      expect(messageContent(assistant)).toEqual([{ type: "text", text: `${status} answer` }]);
      expect(assistant).toMatchObject({ role: "assistant", stopReason });
      expect(projection.responseItems).toHaveLength(status === "completed" ? 6 : 5);
      expect(projection.responseItems.at(-1)).toEqual(
        status === "completed"
          ? responseMessage("assistant", "completed answer")
          : responseMessage("user", `${status} question`),
      );
      if (status === "failed") {
        expect(assistant).toMatchObject({ errorMessage: "provider disconnected" });
      } else {
        expect(assistant).not.toHaveProperty("errorMessage");
      }
    }
  });

  it("retains refused history with an assistant item", () => {
    const explanation = "The proposed action differed from the requested task.";
    const continuation = { message: "  Continue only the requested task.\n" };
    const projection = project([
      turn("turn-refused", [historyItem("assistant-refused", "The request was paused.")], {
        status: "failed",
        error: refusal(explanation, { errorType: "future_category", steer: continuation }),
      }),
    ]);
    expect(projection.transcriptMessages).toHaveLength(1);
    expect(projection.transcriptMessages[0]).toMatchObject({
      role: "assistant",
      stopReason: "error",
      diagnostics: [
        {
          type: "provider_refusal",
          details: {
            provider: "openai",
            category: "misalignment",
            nativeThreadId: thread.id,
            nativeTurnId: "turn-refused",
            review: { explanation, continuation, errorType: "future_category" },
          },
        },
      ],
    });
    expect(projection.responseItems).toEqual([]);
  });

  it("includes review findings in the bounded history byte budget", () => {
    const explanation = "x".repeat(64 * 1024);
    const turns = Array.from({ length: 10 }, (_, index) =>
      turn(`turn-review-${index}`, [], {
        status: "failed",
        error: refusal(explanation),
      }),
    );
    const projection = project(turns);
    expect(projection.transcriptMessages.length).toBeGreaterThan(0);
    expect(projection.transcriptMessages.length).toBeLessThan(turns.length);
    expect(Buffer.byteLength(JSON.stringify(projection.transcriptMessages), "utf8")).toBeLessThan(
      512 * 1024,
    );
    expect(projection.transcriptMessages.at(-1)).toMatchObject({
      diagnostics: [{ details: { review: { explanation } } }],
    });
  });

  it("enforces UTF-8 byte limits without splitting multibyte text", () => {
    const oversizedText = `prefix-${"🙂".repeat(20_000)}-suffix`;
    const projection = project(
      Array.from({ length: 9 }, (_, index) =>
        turn(`turn-${index}`, [userItem(`user-${index}`, `${index}:${oversizedText}`)]),
      ),
    );
    const texts = projection.transcriptMessages.map((message) => {
      const content = messageContent(message);
      return typeof content === "string" ? content : "";
    });

    expect(texts).toHaveLength(8);
    expect(texts[0]).toMatch(/^1:prefix-/u);
    for (const text of texts) {
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64 * 1024);
      expect(text).not.toContain("�");
      expect(text.endsWith("[Message truncated during Codex history import.]")).toBe(true);
    }
    expect(
      texts.reduce((bytes, text) => bytes + Buffer.byteLength(text, "utf8"), 0),
    ).toBeLessThanOrEqual(512 * 1024);
  });

  it("rejects a non-terminal or missing boundary and projects no history without one", () => {
    expect(() => project(thread, "turn-active")).toThrow(
      "Codex history boundary turn is not terminal: turn-active",
    );
    expect(() => project(thread, "turn-missing")).toThrow(
      "Codex history boundary turn not found: turn-missing",
    );
    expect(project(thread, null)).toEqual({
      responseItems: [],
      transcriptMessages: [],
    });
  });
});

describe("importCodexThreadHistoryToTranscript", () => {
  const { createSqliteMirrorTarget: createHistoryTarget } = createTranscriptMirrorTestHarness();
  async function prepare(turns: CodexTurn[], modelProvider?: string) {
    const target = await createHistoryTarget("codex-history-");
    const thread: CodexThread = { id: "thread-history", projectId: null, turns, modelProvider };
    return { target, thread, options: { ...target, thread, throughTurnId: turns.at(-1)!.id } };
  }

  it("preserves mixed attachment order without exposing content or paths", async () => {
    const privateValues = [
      "data:audio/wav",
      "c2VjcmV0LWF1ZGlv",
      "data:image/png",
      "c2VjcmV0LWltYWdl",
      "/private/codex/secret-mixed-recording.wav",
      "/private/codex/secret-mixed-legacy.wav",
    ];
    const content = [
      { type: "text", text: "Before the recording" },
      { type: "audio", url: "data:audio/wav;base64,c2VjcmV0LWF1ZGlv" },
      { type: "text", text: "After the recording" },
      { type: "image", url: "data:image/png;base64,c2VjcmV0LWltYWdl" },
      { type: "localAudio", path: privateValues[4] },
      { type: "local_audio", path: privateValues[5] },
    ];
    const text =
      "Before the recording\n[Audio attachment]\nAfter the recording\n" +
      "[Image attachment]\n[Audio attachment]\n[Audio attachment]";
    const { target, thread, options } = await prepare(
      [
        turn("turn-1", [
          historyItem("user-1", "", { type: "userMessage", content }),
          historyItem("answer", "Received.", { phase: "final_answer" }),
        ]),
      ],
      "source-provider",
    );
    const projected = project(thread, "turn-1");
    expect(projected.responseItems).toEqual([
      responseMessage("user", text),
      responseMessage("assistant", "Received.", "final_answer"),
    ]);
    await importCodexThreadHistoryToTranscript(options);
    expect(await readMirrorMessages(target)).toEqual([
      { role: "user", text },
      row("assistant", "Received."),
    ]);
    const raw = await readMirrorRaw(target);
    expect(raw).toContain('"provider":"source-provider"');
    for (const privateValue of privateValues) {
      expect(JSON.stringify(projected.responseItems)).not.toContain(privateValue);
      expect(raw).not.toContain(privateValue);
    }
  });

  it("imports only visible items with stable identities and native timestamps", async () => {
    const { target, thread, options } = await prepare([
      turn(
        "turn-1",
        [
          historyItem("user-1", "", {
            type: "userMessage",
            content: [
              { type: "text", text: "Review this image" },
              { type: "image", url: "data:image/png;base64,private" },
            ],
          }),
          historyItem("reasoning-1", "", {
            type: "reasoning",
            summary: ["private reasoning"],
            content: ["private chain of thought"],
          }),
          historyItem("command-1", "", {
            type: "commandExecution",
            command: "print-secret",
            aggregatedOutput: "private tool output",
          }),
          historyItem("assistant-1", "The visible answer", { phase: "final_answer" }),
        ],
        { startedAt: 1_700_000_000, completedAt: 1_700_000_001 },
      ),
    ]);
    const projected = project(thread, "turn-1");
    expect(projected.responseItems).toEqual([
      responseMessage("user", "Review this image\n[Image attachment]"),
      responseMessage("assistant", "The visible answer", "final_answer"),
    ]);
    await importCodexThreadHistoryToTranscript(options);
    const messages = await readTranscriptMessages(target);
    const expected = [
      {
        role: "user",
        content: "Review this image\n[Image attachment]",
        timestamp: 1_700_000_000_000,
        idempotencyKey: "codex-app-server:thread-history:history:turn-1:user-1",
      },
      {
        role: "assistant",
        content: fixture.text("The visible answer"),
        api: "openai-chatgpt-responses",
        provider: "openai",
        model: "native-history",
        stopReason: "stop",
        timestamp: 1_700_000_001_003,
        idempotencyKey: "codex-app-server:thread-history:history:turn-1:assistant-1",
      },
    ];
    expect(messages).toMatchObject(expected);
    const marker = `sqlite:${target.agentId}:${target.sessionId}:${target.storePath}`;
    expect(
      await readCodexMirroredSessionHistoryMessages({ ...target, sessionFile: marker }),
    ).toMatchObject(
      expected.map(({ timestamp: _timestamp, idempotencyKey: _key, ...message }) => message),
    );
    for (const raw of [JSON.stringify(projected.responseItems), await readMirrorRaw(target)]) {
      for (const privateValue of [
        "private reasoning",
        "private chain of thought",
        "private tool output",
        "data:image",
      ]) {
        expect(raw).not.toContain(privateValue);
      }
    }
  });

  it("keeps the newest 200 messages and deduplicates repeated imports", async () => {
    const { target, options } = await prepare(
      Array.from({ length: 205 }, (_, index) =>
        turn(`turn-${index}`, [userItem(`user-${index}`, `message-${index}`)], {
          startedAt: 1_700_000_000 + index,
          completedAt: 1_700_000_000 + index,
        }),
      ),
    );
    await importCodexThreadHistoryToTranscript(options);
    await importCodexThreadHistoryToTranscript(options);
    const messages = await readMirrorMessages(target);
    expect(messages).toHaveLength(200);
    expect(messages[0]).toMatchObject({ text: "message-5" });
    expect(messages.at(-1)).toMatchObject({ text: "message-204" });
  });
});

import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import {
  loadTranscriptEvents,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readLatestTranscriptAssistantTextAsync } from "../config/sessions/session-transcript-assistant-read.js";
import type { PersistedUserTurnMessage } from "../sessions/user-turn-transcript.types.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  resolveAssistantReplySource,
  withAssistantReplySource,
} from "./embedded-agent-reply-source.js";
import type { UserTranscriptContext } from "./embedded-agent-runner/run/attempt-llm-boundary.types.js";
import { buildPayloads } from "./embedded-agent-runner/run/payloads.test-helpers.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { persistAgentSessionMessage } from "./sessions/agent-session-transcript.js";
import { SessionManager } from "./sessions/session-manager.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function input(messageId: string, conversationRef = "telegram:fixture"): UserTranscriptContext {
  const transcriptMessage: PersistedUserTurnMessage = {
    role: "user",
    content: "Synthetic input",
    timestamp: 0,
    __openclaw: {
      transport: { channel: "telegram", conversationRef, messageId },
      senderIdentity: { accountId: "default" },
    },
  };
  return { runtimeMessage: { ...transcriptMessage }, transcriptMessage };
}

const assistant = (text: string) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }] });

describe("consumed input reply sources", () => {
  it("keeps buffered and final answers on their consumed inputs after later steering", async () => {
    const state = await createOpenClawTestState({ label: "reply-source-persistence" });
    onTestFinished(() => state.cleanup());
    const target = {
      agentId: "main",
      sessionId: "reply-source",
      sessionKey: "agent:main:reply-source",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const manager = await SessionManager.openAsync(target, state.workspaceDir);
    const contexts = [input("101")];
    const onBlockReply = vi.fn();
    const delivery = Promise.withResolvers<void>();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "reply-source",
      sessionExtras: { sessionManager: manager },
      messageChannel: "telegram",
      getUserTranscriptContexts: () => contexts,
      onBlockReply,
      onBlockReplyFlush: () => delivery.promise,
      onBeforeTerminalDelivery: () => {},
      blockReplyBreak: "message_end",
    });
    onTestFinished(async () => {
      delivery.resolve();
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
    });
    const first = assistant("First answer");
    emit({ type: "message_start", message: first });
    contexts.push(input("102"));
    emit({ type: "message_end", message: first });
    await persistAgentSessionMessage(manager, first, { invalidateSerializedPrefixCache: false });
    emit({ type: "message_end", message: contexts[1]?.runtimeMessage });
    const second = assistant("Second answer");
    emit({ type: "message_start", message: second });
    contexts.push(input("103"));
    emit({ type: "message_end", message: second });
    // Persist before buffered lifecycle handlers settle, as AgentSessionBase does.
    await persistAgentSessionMessage(manager, second, { invalidateSerializedPrefixCache: false });
    delivery.resolve();
    emit({ type: "agent_end", messages: [first, second] });
    await subscription.waitForPendingEvents();
    expect(onBlockReply.mock.calls.map(([payload]) => payload.replyToId)).toEqual(["101", "102"]);
    const stored = (await loadTranscriptEvents(target)).flatMap((event) =>
      isRecord(event) && isRecord(event.message) && event.message.role === "assistant"
        ? [event.message]
        : [],
    );
    expect(stored).toMatchObject([
      {
        content: [{ type: "text", text: "First answer" }],
        openclawDelivery: { sourceMessageId: "101" },
      },
      {
        content: [{ type: "text", text: "Second answer" }],
        openclawDelivery: { sourceMessageId: "102" },
      },
    ]);
    expect(await readLatestTranscriptAssistantTextAsync(target)).toMatchObject({
      text: "Second answer",
      openclawDelivery: { sourceMessageId: "102" },
    });
    const payloads = buildPayloads({
      assistantTexts: subscription.assistantTexts,
      answerSegments: subscription.answerSegments,
      currentAssistant: second,
      lastAssistant: second,
      assistantMessageIndex: 2,
    });
    expect(
      payloads.map(({ text, replyToId, replyToTag }) => ({
        text,
        replyToId,
        explicit: Boolean(replyToTag),
      })),
    ).toEqual([
      { text: "First answer", replyToId: "101", explicit: false },
      { text: "Second answer", replyToId: "102", explicit: false },
    ]);
    expect(
      payloads.map((payload) => getReplyPayloadMetadata(payload)?.assistantMessageIndex),
    ).toEqual([1, 2]);
  });

  it("preserves explicit quotes and suppression, while current means the consumed input", () => {
    for (const payload of [{ replyToId: "90" }, { replyToTag: true }, { replyToCurrent: false }]) {
      expect(withAssistantReplySource(payload, "102")).toBe(payload);
    }
    expect(withAssistantReplySource({ replyToId: "101", replyToCurrent: true }, "102")).toEqual({
      replyToId: "102",
      replyToCurrent: true,
    });
    const message = assistant("Explicit quote");
    message.openclawDelivery = { replyToId: "90", sourceMessageId: "102" };
    expect(buildPayloads({ currentAssistant: message, lastAssistant: message })[0]?.replyToId).toBe(
      "90",
    );
  });

  it("ignores foreign conversations, accounts, internal inputs and malformed Telegram ids", () => {
    const first = input("101");
    const internal = input("102");
    if (internal.transcriptMessage.role === "user") {
      const user: PersistedUserTurnMessage = internal.transcriptMessage;
      user.provenance = { kind: "internal_system" };
    }
    const otherAccount = input("102");
    if (otherAccount.transcriptMessage.role === "user") {
      const user: PersistedUserTurnMessage = otherAccount.transcriptMessage;
      user["__openclaw"] = { ...user["__openclaw"], senderIdentity: { accountId: "other" } };
    }
    for (const other of [input("102", "other"), otherAccount, internal, input("0"), input("1:2")]) {
      expect(resolveAssistantReplySource([first, other], "telegram")).toBeUndefined();
    }
    expect(resolveAssistantReplySource([first], "webchat")).toBeUndefined();
    expect(resolveAssistantReplySource([], "telegram")).toBeUndefined();
  });
});

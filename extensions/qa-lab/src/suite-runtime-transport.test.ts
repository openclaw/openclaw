import { describe, expect, it } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaChannelTransport } from "./qa-channel-transport.js";
import {
  formatTransportTranscript,
  readTransportTranscript,
  waitForNoOutbound,
  waitForOutboundMessage,
} from "./suite-runtime-transport.js";

function createMessages(state = createQaBusState()) {
  return {
    state,
    cursor: () =>
      state.getSnapshot().messages.filter((message) => message.direction === "outbound").length,
    outbound: (text: string, extra: Partial<Parameters<typeof state.addOutboundMessage>[0]> = {}) =>
      state.addOutboundMessage({
        to: "dm:qa-operator",
        senderId: "openclaw",
        senderName: "OpenClaw QA",
        text,
        ...extra,
      }),
    inbound: (text: string) =>
      state.addInboundMessage({
        conversation: { id: "qa-operator", kind: "direct" },
        senderId: "alice",
        senderName: "Alice",
        text,
      }),
  };
}

describe("qa suite transport helpers", () => {
  it.each([
    [
      "internal coordination text",
      "QA_LEAK_OK",
      "checking thread context; then post a tight progress reply here.\nQA_LEAK_OK",
      "checking thread context",
    ],
    [
      "failed status with equals syntax",
      "QA-RESTART-OK",
      "status=FAILED\nerror=Could not parse services",
      "Could not parse services",
    ],
  ])("fails success-only waits on %s", async (_name, marker, text, error) => {
    const { state, outbound } = createMessages();
    const pending = waitForOutboundMessage(
      state,
      (candidate) => candidate.text.includes(marker),
      5_000,
    );
    outbound(text);
    await expect(pending).rejects.toThrow(error);
  });

  it("checks no-outbound waits from the supplied outbound cursor", async () => {
    const { state, outbound, cursor } = createMessages();
    outbound("previous scenario reply");
    const sinceIndex = cursor();

    await expect(waitForNoOutbound(state, 1, { sinceIndex })).resolves.toBeUndefined();

    outbound("current scenario reply", { to: "channel:qa-room" });
    await expect(waitForNoOutbound(state, 1, { sinceIndex })).rejects.toThrow(
      "expected no outbound messages, saw 1: channel:qa-room:openclaw:current scenario reply",
    );
  });

  it("waits for a live final instead of accepting a deleted matching preview", async () => {
    const { state, outbound } = createMessages();
    const preview = outbound("QA-VISIBLE-FINAL-OK");
    state.deleteMessage({ messageId: preview.id });
    const final = outbound("QA-VISIBLE-FINAL-OK");

    await expect(
      waitForOutboundMessage(state, (message) => message.text.includes("QA-VISIBLE-FINAL-OK"), 50),
    ).resolves.toMatchObject({ id: final.id });
  });

  it("filters foreign account replies and failures from account-scoped waits", async () => {
    const { state, outbound } = createMessages();
    outbound("QA-ACCOUNT-OK", { accountId: "other" });
    outbound("⚠️ agent failed before reply: foreign account failure", {
      accountId: "other",
      isError: true,
    });
    const expected = outbound("QA-ACCOUNT-OK", { accountId: "default" });

    await expect(
      waitForOutboundMessage(state, (message) => message.text.includes("QA-ACCOUNT-OK"), 50, {
        accountId: "default",
      }),
    ).resolves.toMatchObject({ accountId: "default", id: expected.id });
  });

  it("fails raw scenario waitForCondition calls even when mixed traffic already exists", async () => {
    const { state, inbound, outbound } = createMessages();
    inbound("hello");
    outbound("working on it");
    inbound("ok do it");

    const waitForCondition = createQaChannelTransport(state).waitForCondition;
    const pending = waitForCondition(
      () =>
        state
          .getSnapshot()
          .messages.slice(3)
          .findLast(
            (message) =>
              message.direction === "outbound" &&
              message.conversation.id === "qa-operator" &&
              message.text.includes("mission"),
          ),
      150,
      10,
    );

    outbound('⚠️ No API key found for provider "openai".', { isError: true });

    await expect(pending).rejects.toThrow('No API key found for provider "openai".');
  });

  it("reads transport transcripts with generic helper names", () => {
    const { state, inbound, outbound } = createMessages();
    inbound("hello");
    outbound("working on it");
    outbound("done");

    const messages = readTransportTranscript(state, {
      conversationId: "qa-operator",
      direction: "outbound",
    });
    const formatted = formatTransportTranscript(state, {
      conversationId: "qa-operator",
    });

    expect(messages.map((message: { text: string }) => message.text)).toEqual([
      "working on it",
      "done",
    ]);
    expect(formatted).toContain("USER Alice: hello");
    expect(formatted).toContain("ASSISTANT OpenClaw QA: working on it");
  });

  it("applies account filtering after the global outbound cursor", async () => {
    const { state, outbound, cursor } = createMessages();
    outbound("previous account reply", { accountId: "other" });
    const sinceIndex = cursor();
    const expected = outbound("done", { accountId: "default" });

    await expect(
      waitForOutboundMessage(state, (candidate) => candidate.text === "done", 50, {
        accountId: "default",
        sinceIndex,
      }),
    ).resolves.toMatchObject({ accountId: "default", id: expected.id });
  });
});

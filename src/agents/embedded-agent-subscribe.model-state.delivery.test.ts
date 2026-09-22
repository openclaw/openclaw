import { expectDefined } from "@openclaw/normalization-core";
import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { buildEmbeddedRunPayloads } from "./embedded-agent-runner/run/payloads.js";
import { subscribeEmbeddedAgentSession } from "./embedded-agent-subscribe.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "./sessions/agent-session-loop-correctness.test-support.js";

registerAgentSessionLoopTestLifecycle();

const literal = "Use `[[reply_to_current]]`, `[[audio_as_voice]]`, and `[[tts:text]]` literally.";

describe("completed assistant delivery snapshot", () => {
  it.each([
    {
      name: "reply to current message",
      source: "[[reply_to_current]]Current reply.",
      text: "Current reply.",
      facts: { replyToCurrent: true },
      payload: { replyToCurrent: true, replyToTag: true },
    },
    {
      name: "explicit reply target",
      source: "[[reply_to:12345]]Target reply.",
      text: "Target reply.",
      facts: { replyToId: "12345" },
      payload: { replyToId: "12345", replyToTag: true },
    },
    {
      name: "voice intent",
      source: "[[audio_as_voice]]Voice reply.",
      text: "Voice reply.",
      facts: { audioAsVoice: true },
      payload: { audioAsVoice: true },
    },
    {
      name: "tagged speech",
      source: "Shown. [[tts:text]]Spoken.[[/tts:text]]",
      text: "Shown.",
      facts: { tts: { tagged: true, text: "Spoken." } },
      payload: {},
    },
    {
      name: "speech without visible text",
      source: "[[tts:text]]Spoken only.[[/tts:text]]",
      text: "",
      facts: { tts: { tagged: true, text: "Spoken only." } },
      payload: {},
    },
    {
      name: "speech facts alongside a silent text reply",
      source: "[[tts:text]]Do not speak.[[/tts:text]]NO_REPLY",
      text: "NO_REPLY",
      facts: { tts: { tagged: true, text: "Do not speak." } },
      payload: {},
    },
    {
      name: "a genuine reply token split across native parts",
      source: ["[[reply_to:", "12345]]Target reply."],
      parts: ["Target reply.", ""],
      text: "Target reply.",
      facts: { replyToId: "12345" },
      payload: { replyToId: "12345", replyToTag: true },
    },
    {
      name: "genuine speech text split across native parts",
      source: ["Shown. [[tts:text]]", "Spoken.[[/tts:text]]"],
      parts: ["Shown.", ""],
      text: "Shown.",
      facts: { tts: { tagged: true, text: "Spoken." } },
      payload: {},
    },
    {
      name: "an inline literal split across native parts",
      source: ["Use `", "[[reply_to:literal]]` literally."],
      parts: ["Use `", "[[reply_to:literal]]` literally."],
      text: "Use `\n[[reply_to:literal]]` literally.",
      facts: undefined,
      payload: {},
    },
    {
      name: "a fenced literal followed by a genuine target",
      source: [
        "```text",
        "[[reply_to_current]]\n[[audio_as_voice]]",
        "```\n[[reply_to:actual]]Done.",
      ],
      parts: ["```text", "[[reply_to_current]]\n[[audio_as_voice]]", "```\nDone."],
      text: "```text\n[[reply_to_current]]\n[[audio_as_voice]]\n```\nDone.",
      facts: { replyToId: "actual" },
      payload: { replyToId: "actual", replyToTag: true },
    },
    {
      name: "a TTS literal split across native parts",
      source: ["Use `", "[[tts:text]]not speech[[/tts:text]]` literally."],
      parts: ["Use `", "[[tts:text]]not speech[[/tts:text]]` literally."],
      text: "Use `\n[[tts:text]]not speech[[/tts:text]]` literally.",
      facts: undefined,
      payload: {},
    },
    {
      name: "genuine voice intent after a split literal",
      source: ["Use `", "[[audio_as_voice]]` literally.\n[[audio_as_voice]]Voice."],
      parts: ["Use `", "[[audio_as_voice]]` literally.\nVoice."],
      text: "Use `\n[[audio_as_voice]]` literally.\nVoice.",
      facts: { audioAsVoice: true },
      payload: { audioAsVoice: true },
    },
    {
      name: "plain text",
      source: "Plain reply.",
      text: "Plain reply.",
      facts: undefined,
      payload: {},
    },
    { name: "literal directives", source: literal, text: literal, facts: undefined, payload: {} },
  ])("preserves $name without changing the raw completion event", async (scenario) => {
    const sourceParts = Array.isArray(scenario.source) ? scenario.source : [scenario.source];
    const contentFor = (parts: readonly string[]) =>
      parts.map((text, index) => ({
        type: "text" as const,
        text,
        textSignature: JSON.stringify({ v: 1, id: `part-${index}`, phase: "final_answer" }),
      }));
    streamMocks.streamSimple.mockImplementation((model: Model) =>
      createAssistantResultStream(createAssistant(model, contentFor(sourceParts))),
    );
    const { session, sessionManager } = await createTestSession();
    const subscription = subscribeEmbeddedAgentSession({ session, runId: "completed-delivery" });
    let rawCompletion: AssistantMessage | undefined;
    const stopObserve = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        rawCompletion = structuredClone(event.message);
      }
    });
    try {
      await session.prompt("Return the supplied synthetic reply.");
      await subscription.waitForPendingEvents();
      const captured = expectDefined(
        subscription.getCurrentAttemptAssistant(),
        "Completed assistant",
      );
      const content = contentFor(scenario.parts ?? [scenario.text]);
      const persisted = sessionManager
        .getEntries()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      const payloads = buildEmbeddedRunPayloads({
        assistantTexts: subscription.assistantTexts,
        lastAssistant: captured,
        currentAssistant: captured,
        sessionKey: "agent:main:completed-delivery",
      });

      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(1);
      expect.soft(rawCompletion?.content).toEqual(contentFor(sourceParts));
      expect.soft(rawCompletion?.openclawDelivery).toBeUndefined();
      expect.soft(captured.content).toEqual(content);
      expect.soft(captured.openclawDelivery).toEqual(scenario.facts);
      expect.soft(persisted).toMatchObject({
        type: "message",
        message: { content, ...(scenario.facts ? { openclawDelivery: scenario.facts } : {}) },
      });
      expect.soft(payloads).toHaveLength(1);
      expect.soft(payloads[0]).toMatchObject({
        text: scenario.text === "NO_REPLY" ? undefined : scenario.text || undefined,
        ...scenario.payload,
      });
      expect
        .soft(getReplyPayloadMetadata(expectDefined(payloads[0], "Final payload"))?.tts)
        .toEqual(scenario.facts?.tts);
    } finally {
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
      stopObserve();
    }
  });
});

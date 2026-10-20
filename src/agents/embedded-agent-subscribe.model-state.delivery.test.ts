import { expectDefined } from "@openclaw/normalization-core";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { resolveRawAssistantAnswerText } from "../shared/assistant-answer-text.js";
import { prepareAgentRunTerminalReply } from "./agent-run-terminal-reply.js";
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

it.each([
  [
    "speech facts alongside a literal silence token",
    ["[[tts:text]]Do not speak.[[/tts:text]]NO_REPLY"],
    ["NO_REPLY"],
    { tts: { tagged: true, text: "Do not speak." } },
    {},
  ],
  [
    "a fenced literal followed by a genuine target",
    ["```text", "[[reply_to_current]]\n[[audio_as_voice]]", "```\n[[reply_to:actual]]Done."],
    ["```text", "[[reply_to_current]]\n[[audio_as_voice]]", "```\nDone."],
    { replyToId: "actual" },
    { replyToId: "actual", replyToTag: true },
  ],
  [
    "genuine voice intent after a split literal",
    ["Use `", "[[audio_as_voice]]` literally.\n[[audio_as_voice]]Voice."],
    ["Use `", "[[audio_as_voice]]` literally.\nVoice."],
    { audioAsVoice: true },
    { audioAsVoice: true },
  ],
] as const)(
  "preserves %s without changing the raw completion event",
  async (_name, sourceParts, parts, facts, payload) => {
    const contentFor = (chunks: readonly string[]) =>
      chunks.map((text, index) => ({
        type: "text" as const,
        text,
        textSignature: JSON.stringify({ v: 1, id: `part-${index}`, phase: "final_answer" }),
      }));
    streamMocks.streamSimple.mockImplementation((model) =>
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
      const content = contentFor(parts);
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
      expect.soft(captured.content).toEqual(contentFor(sourceParts));
      expect.soft(captured.openclawDelivery).toEqual(facts);
      expect(
        prepareAgentRunTerminalReply({ rawText: resolveRawAssistantAnswerText(captured) })
          .terminalReply.disposition,
      ).toBe("visible");
      expect.soft(persisted).toMatchObject({
        type: "message",
        message: { content, openclawDelivery: facts },
      });
      expect.soft(payloads).toHaveLength(1);
      expect.soft(payloads[0]).toMatchObject({
        text: parts.join("\n"),
        ...payload,
      });
      expect
        .soft(getReplyPayloadMetadata(expectDefined(payloads[0], "Final payload"))?.tts)
        .toEqual("tts" in facts ? facts.tts : undefined);
    } finally {
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
      stopObserve();
    }
  },
);

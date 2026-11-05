import { expectDefined } from "@openclaw/normalization-core";
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { resolveRawAssistantAnswerText as rawText } from "../shared/assistant-answer-text.js";
import { prepareAgentRunTerminalReply as prepareReply } from "./agent-run-terminal-reply.js";
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

const speechSource = ["[[tts:text]]Do not speak.[[/tts:text]]NO_REPLY"];
const speech = { tts: { tagged: true, text: "Do not speak." } };
const quoted = ["```text", "[[reply_to_current]]\n[[audio_as_voice]]"];
const targetSource = [...quoted, "```\n[[reply_to:actual]]Done."];
const targetParts = [...quoted, "```\nDone."];
const target = { replyToId: "actual" };
const targetPayload = { ...target, replyToTag: true };
const literal = "[[audio_as_voice]]` literally.\n";
const voiceSource = ["Use `", `${literal}[[audio_as_voice]]Voice.`];
const voiceParts = ["Use `", `${literal}Voice.`];

it.each([
  ["speech beside NO_REPLY", speechSource, ["NO_REPLY"], speech, {}],
  ["target after fenced literals", targetSource, targetParts, target, targetPayload],
  ["literal + voice", voiceSource, voiceParts, { audioAsVoice: true }, { audioAsVoice: true }],
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
    let raw: AssistantMessage | undefined;
    const stopObserve = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        raw = structuredClone(event.message);
      }
    });
    try {
      await session.prompt("Return the supplied synthetic reply.");
      await subscription.waitForPendingEvents();
      const reply = expectDefined(subscription.getCurrentAttemptAssistant(), "Assistant");
      const expectedMessage = { content: contentFor(parts), openclawDelivery: facts };
      const persisted = sessionManager
        .getEntries()
        .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
      const payloads = buildEmbeddedRunPayloads({
        assistantTexts: subscription.assistantTexts,
        lastAssistant: reply,
        currentAssistant: reply,
        sessionKey: "agent:main:completed-delivery",
      });

      expect(streamMocks.streamSimple).toHaveBeenCalledTimes(1);
      const rawContent = contentFor(sourceParts);
      expect.soft([raw?.content, raw?.openclawDelivery]).toEqual([rawContent, undefined]);
      expect.soft([reply.content, reply.openclawDelivery]).toEqual([rawContent, facts]);
      expect(prepareReply({ rawText: rawText(reply) }).terminalReply.disposition).toBe("visible");
      expect.soft(persisted).toMatchObject({ type: "message", message: expectedMessage });
      expect.soft(payloads).toMatchObject([{ text: parts.join("\n"), ...payload }]);
      const tts = getReplyPayloadMetadata(expectDefined(payloads[0], "Final payload"))?.tts;
      expect.soft(tts).toEqual("tts" in facts ? facts.tts : undefined);
    } finally {
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
      stopObserve();
    }
  },
);

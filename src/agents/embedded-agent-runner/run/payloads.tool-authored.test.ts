import { expect, it } from "vitest";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { buildPayloads } from "./payloads.test-helpers.js";

const [EARLIER, LATER, PREAMBLE] = ["Earlier answer.", "Later answer.", "Checking order."] as const;
const context = { sessionKey: "agent:vinalia:telegram:123", agentId: "vinalia" };
const toolAuthoredReply = {
  text: "Pedido SO1 creado. 18 botellas · total 459,85 €.",
  mediaUrls: ["/tmp/albaran.pdf"],
  idempotencyKey: "run-1:tool-source-reply:tc-1",
  sourceReplyFinal: true,
  toolAuthored: true as const,
  toolAuthoredForToolCallId: "tc-1",
};

const toolMessage = (text: string = PREAMBLE) =>
  makeAgentAssistantMessage({
    stopReason: "toolUse",
    content: [
      { type: "text", text },
      { type: "toolCall", id: "tc-1", name: "order_status", arguments: {} },
    ],
  });
const toolAssistant = toolMessage();

const buildToolPayloads = (options: Parameters<typeof buildPayloads>[0]) =>
  buildPayloads({
    assistantTexts: [PREAMBLE],
    answerSegments: [segment(toolAssistant)],
    messagingToolSourceReplyPayloads: [toolAuthoredReply],
    ...options,
  });
const textAssistant = (text: string) =>
  makeAgentAssistantMessage({ content: [{ type: "text", text }] });

function segment(lastAssistant: ReturnType<typeof textAssistant>, index = 1) {
  return { textEnd: index, messageEnd: index, finalMessageStart: index, lastAssistant };
}

it.each(["automatic", "message_tool_only", undefined] as const)("keeps replies (%s)", (mode) => {
  const laterAnswer = mode !== undefined;
  const earlier = laterAnswer
    ? textAssistant(EARLIER)
    : { ...toolMessage(EARLIER), turnId: "earlier-turn" };
  const reply = laterAnswer
    ? toolAuthoredReply
    : { ...toolAuthoredReply, toolAuthoredForTurnId: "current-turn" };
  const payloads = buildToolPayloads({
    sourceReplyDeliveryMode: mode,
    ...(laterAnswer ? { ...context, runId: "run-1" } : {}),
    assistantTexts: [EARLIER, PREAMBLE, ...(laterAnswer ? [LATER] : [])],
    answerSegments: [segment(earlier), ...(laterAnswer ? [segment(toolAssistant, 2)] : [])],
    lastAssistant: laterAnswer
      ? textAssistant(LATER)
      : { ...toolAssistant, turnId: "current-turn" },
    messagingToolSourceReplyPayloads: [reply],
  });
  expect(payloads.map((payload) => payload.text)).toEqual([
    EARLIER,
    toolAuthoredReply.text,
    ...(laterAnswer ? [LATER] : []),
  ]);
  if (laterAnswer) {
    expect(payloads[1]?.mediaUrls).toEqual(["/tmp/albaran.pdf"]);
    const metadata = getReplyPayloadMetadata(payloads[1] as object);
    expect(metadata?.deliverDespiteSourceReplySuppression).toBe(true);
    expect(metadata?.sourceReplyTranscriptMirror).toEqual({
      ...context,
      text: toolAuthoredReply.text,
      mediaUrls: ["/tmp/albaran.pdf"],
      idempotencyKey: "run-1:tool-source-reply:tc-1",
    });
  }
});

it.each(["assistant", "tool"])("retains later %s failure", (kind) => {
  const payloads = buildToolPayloads(
    kind === "assistant"
      ? {
          sourceReplyDeliveryMode: "message_tool_only",
          lastAssistant: makeAgentAssistantMessage({
            stopReason: "error",
            content: [],
            errorMessage: "Provider request failed.",
          }),
        }
      : { lastToolError: { toolName: "read", error: "Missing file" } },
  );
  expect(payloads[0]?.text).toBe(toolAuthoredReply.text);
  expect(payloads.some((payload) => payload.isError)).toBe(true);
});

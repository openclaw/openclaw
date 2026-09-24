import { expect, it } from "vitest";
import {
  createMockServerTestHarness,
  expectNonStreamingResponsesJson,
  makeUserInput,
  outputText,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

it("requires both WhatsApp batched markers in the current turn without leaking prior batches", async () => {
  const server = await startMockServer();
  const first =
    "First batched WhatsApp QA message WHATSAPP_QA_BATCHED_FIRST_TEST. " +
    "Wait for the next message before replying.";
  const second =
    "Second batched WhatsApp QA message. Reply with only this exact marker: " +
    "WHATSAPP_QA_BATCHED_FINAL_TEST only if the first and second messages appear " +
    "together in this single inbound message.";
  const combined = `${first}\n${second}`;
  for (const { input, expected } of [
    { input: [second], expected: "WHATSAPP_QA_BATCHED_MISSING_CONTEXT_TEST" },
    { input: [first, second], expected: "WHATSAPP_QA_BATCHED_MISSING_CONTEXT_TEST" },
    {
      input: [
        `<conversation_context>\n[user]\n${first}\n</conversation_context>\n\nCurrent user request:\n${second}`,
      ],
      expected: "WHATSAPP_QA_BATCHED_MISSING_CONTEXT_TEST",
    },
    { input: [combined], expected: "WHATSAPP_QA_BATCHED_FINAL_TEST" },
    {
      input: [combined, "Reply with only this exact marker: FRESH_TURN"],
      expected: "FRESH_TURN",
    },
    {
      input: [combined, second.replaceAll("_TEST", "_NEXT")],
      expected: "WHATSAPP_QA_BATCHED_MISSING_CONTEXT_NEXT",
    },
  ]) {
    const response = await expectNonStreamingResponsesJson(server, {
      input: input.map(makeUserInput),
    });
    expect(outputText(response), input.join(" | ")).toBe(expected);
  }
});

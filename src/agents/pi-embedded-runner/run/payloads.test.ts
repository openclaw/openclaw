import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "./payloads.js";

describe("buildEmbeddedRunPayloads", () => {
  it("suppresses raw API error JSON when the assistant errored", () => {
    const errorJson =
      '{"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CX7DwS7tSvggaNHmefwWg"}';
    const lastAssistant = {
      stopReason: "error",
      errorMessage: errorJson,
      content: [{ type: "text", text: errorJson }],
    } as AssistantMessage;

    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [errorJson],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:telegram",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(payloads[0]?.isError).toBe(true);
    expect(payloads.some((payload) => payload.text === errorJson)).toBe(false);
  });
});

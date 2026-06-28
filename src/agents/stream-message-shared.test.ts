// Stream message tests lock down the sanitized assistant message emitted when a
// provider stream fails mid-response.
import { describe, expect, it } from "vitest";
import {
  STREAM_ERROR_FALLBACK_TEXT,
  buildStreamErrorAssistantMessage,
  isStreamErrorPlaceholderOnlyText,
} from "./stream-message-shared.js";

const model = {
  api: "bedrock-converse-stream",
  provider: "amazon-bedrock",
  id: "anthropic.claude-3-haiku-20240307-v1:0",
};

describe("buildStreamErrorAssistantMessage", () => {
  it("never returns an empty content array", () => {
    const message = buildStreamErrorAssistantMessage({
      model,
      errorMessage: "stream aborted by upstream host=internal.example.com",
    });
    expect(message.content).toStrictEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
  });

  it("places only the sentinel in content and never echoes the raw error text", () => {
    const message = buildStreamErrorAssistantMessage({
      model,
      errorMessage: "stream aborted by upstream host=internal.example.com",
    });
    // Replay-visible content must be the canonical sentinel — replaying raw
    // provider error strings could leak hostnames/metadata to the model and
    // turn them into a prompt-injection surface.
    expect(message.content).toEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
    expect(JSON.stringify(message.content)).not.toContain("internal.example.com");
    // The detailed error remains available in the peer field for clients/UIs.
    expect(message.errorMessage).toBe("stream aborted by upstream host=internal.example.com");
    expect(message.stopReason).toBe("error");
  });

  it("uses the same sentinel when errorMessage is blank", () => {
    const message = buildStreamErrorAssistantMessage({ model, errorMessage: "   " });
    expect(message.content).toEqual([{ type: "text", text: STREAM_ERROR_FALLBACK_TEXT }]);
    // Original errorMessage is preserved verbatim for clients that surface it.
    expect(message.errorMessage).toBe("   ");
  });
});

describe("isStreamErrorPlaceholderOnlyText", () => {
  it("matches a single placeholder occurrence", () => {
    expect(isStreamErrorPlaceholderOnlyText(STREAM_ERROR_FALLBACK_TEXT)).toBe(true);
  });

  it("matches a single placeholder with surrounding whitespace", () => {
    expect(isStreamErrorPlaceholderOnlyText(`   ${STREAM_ERROR_FALLBACK_TEXT}\n`)).toBe(true);
  });

  it("matches many placeholder repetitions separated by newlines", () => {
    // Mirrors the #97357 repro: fallback model echoed the sentinel 43 times.
    const repeated = Array.from({ length: 43 }, () => STREAM_ERROR_FALLBACK_TEXT).join("\n");
    expect(isStreamErrorPlaceholderOnlyText(repeated)).toBe(true);
  });

  it("matches placeholder repetitions separated by mixed whitespace", () => {
    const repeated = `${STREAM_ERROR_FALLBACK_TEXT} \n  ${STREAM_ERROR_FALLBACK_TEXT}\t${STREAM_ERROR_FALLBACK_TEXT}`;
    expect(isStreamErrorPlaceholderOnlyText(repeated)).toBe(true);
  });

  it("rejects undefined, empty, and whitespace-only text", () => {
    expect(isStreamErrorPlaceholderOnlyText(undefined)).toBe(false);
    expect(isStreamErrorPlaceholderOnlyText("")).toBe(false);
    expect(isStreamErrorPlaceholderOnlyText("   \n\t")).toBe(false);
  });

  it("rejects text that merely mentions the placeholder", () => {
    expect(isStreamErrorPlaceholderOnlyText(`I got: ${STREAM_ERROR_FALLBACK_TEXT}`)).toBe(false);
  });

  it("rejects text that mixes the placeholder with other content", () => {
    // Even when the placeholder dominates, any non-placeholder content
    // disqualifies the text — we never suppress a real recovery by mistake.
    const mixed = `${STREAM_ERROR_FALLBACK_TEXT}\nSorry, let me try again.${STREAM_ERROR_FALLBACK_TEXT}`;
    expect(isStreamErrorPlaceholderOnlyText(mixed)).toBe(false);
  });

  it("rejects unrelated text", () => {
    expect(isStreamErrorPlaceholderOnlyText("HEARTBEAT_OK")).toBe(false);
    expect(isStreamErrorPlaceholderOnlyText("[assistant turn failed]")).toBe(false);
  });
});

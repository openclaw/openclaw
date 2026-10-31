import { describe, expect, it } from "vitest";
import { DEFAULT_VIDEO_MAX_BASE64_BYTES } from "./defaults.js";
import {
  coerceOpenAiCompatibleVideoText,
  type OpenAiCompatibleVideoPayload,
} from "./openai-compatible-video.js";
import { estimateBase64Size, resolveVideoMaxBase64Bytes } from "./video.js";

describe("coerceOpenAiCompatibleVideoText", () => {
  it.each<{ name: string; payload: OpenAiCompatibleVideoPayload; expected: string | null }>([
    { name: "missing choices", payload: {}, expected: null },
    { name: "missing message", payload: { choices: [{}] }, expected: null },
    { name: "empty message", payload: { choices: [{ message: {} }] }, expected: null },
    {
      name: "content before reasoning",
      payload: { choices: [{ message: { content: " answer ", reasoning_content: "reasoning" } }] },
      expected: "answer",
    },
    {
      name: "ordered content parts before reasoning",
      payload: {
        choices: [
          {
            message: {
              content: [{ text: " first " }, {}, { text: "\n" }, { text: "second" }],
              reasoning_content: "reasoning",
            },
          },
        ],
      },
      expected: "first\nsecond",
    },
    {
      name: "blank content falls back to reasoning",
      payload: { choices: [{ message: { content: "\n ", reasoning_content: " reason " } }] },
      expected: "reason",
    },
    {
      name: "empty parts fall back to reasoning",
      payload: {
        choices: [{ message: { content: [{ text: " " }], reasoning_content: " reason " } }],
      },
      expected: "reason",
    },
    {
      name: "blank content and reasoning",
      payload: { choices: [{ message: { content: [], reasoning_content: "\n " } }] },
      expected: null,
    },
  ])("extracts $name", ({ payload, expected }) => {
    expect(coerceOpenAiCompatibleVideoText(payload)).toBe(expected);
  });
});

describe("estimateBase64Size", () => {
  it("preserves the uncapped encoded size above the shared payload cap", () => {
    expect(estimateBase64Size(75_000_000)).toBe(100_000_000);
  });
});

describe("resolveVideoMaxBase64Bytes", () => {
  it("allows raw byte limits that expand to valid base64 boundaries", () => {
    expect(resolveVideoMaxBase64Bytes(1)).toBe(4);
    expect(resolveVideoMaxBase64Bytes(2)).toBe(4);
    expect(resolveVideoMaxBase64Bytes(3)).toBe(4);
    expect(resolveVideoMaxBase64Bytes(4)).toBe(8);
  });

  it("keeps the shared maximum base64 payload cap", () => {
    expect(resolveVideoMaxBase64Bytes(DEFAULT_VIDEO_MAX_BASE64_BYTES)).toBe(
      DEFAULT_VIDEO_MAX_BASE64_BYTES,
    );
  });
});

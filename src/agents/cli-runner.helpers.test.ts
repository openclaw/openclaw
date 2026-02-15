import { describe, expect, it } from "vitest";
import { parseCliJson, parseCliJsonl } from "./cli-runner/helpers.js";

describe("cli runner usage parsing", () => {
  it("maps Anthropic cache_creation_input_tokens to cacheWrite in JSON mode", () => {
    const parsed = parseCliJson(
      JSON.stringify({
        message: { text: "ok" },
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 3,
        },
      }),
      { command: "mock" },
    );

    expect(parsed).toMatchObject({
      text: "ok",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 3,
        cacheWrite: 20,
      },
    });
  });

  it("maps Anthropic cache_creation_input_tokens to cacheWrite in JSONL mode", () => {
    const parsed = parseCliJsonl(
      [
        JSON.stringify({
          item: { type: "assistant_message", text: "hello" },
          usage: {
            input_tokens: 7,
            output_tokens: 8,
            cache_creation_input_tokens: 9,
          },
        }),
      ].join("\n"),
      { command: "mock" },
    );

    expect(parsed).toMatchObject({
      text: "hello",
      usage: {
        input: 7,
        output: 8,
        cacheWrite: 9,
      },
    });
  });
});

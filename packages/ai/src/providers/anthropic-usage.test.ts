import { describe, expect, it } from "vitest";
import { readLastAnthropicIterationUsage } from "./anthropic-usage.js";

describe("readLastAnthropicIterationUsage", () => {
  it.each(["message", "compaction", "advisor_message"])(
    "reads the final %s iteration as the context snapshot",
    (type) => {
      expect(
        readLastAnthropicIterationUsage({
          iterations: [
            {
              type: "message",
              input_tokens: 1,
              output_tokens: 2,
              cache_read_input_tokens: 3,
              cache_creation_input_tokens: 4,
            },
            {
              type,
              input_tokens: 12,
              output_tokens: 15_104,
              cache_read_input_tokens: 148_862,
              cache_creation_input_tokens: 0,
            },
          ],
        }),
      ).toEqual({
        state: "valid",
        usage: {
          contextPromptTokens: 148_874,
          totalTokens: 163_978,
        },
      });
    },
  );

  it("reports absent iterations separately from malformed iterations", () => {
    expect(readLastAnthropicIterationUsage({ input_tokens: 1 })).toEqual({ state: "absent" });
  });

  it("does not reuse an earlier iteration when the final iteration is malformed", () => {
    expect(
      readLastAnthropicIterationUsage({
        iterations: [
          {
            type: "message",
            input_tokens: 12,
            output_tokens: 15_104,
            cache_read_input_tokens: 148_862,
            cache_creation_input_tokens: 0,
          },
          {
            type: "message",
            input_tokens: "malformed",
            output_tokens: 1,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        ],
      }),
    ).toEqual({ state: "invalid" });
  });

  it("rejects a final iteration with incomplete cache usage", () => {
    expect(
      readLastAnthropicIterationUsage({
        iterations: [
          {
            type: "message",
            input_tokens: 12,
            output_tokens: 15_104,
          },
        ],
      }),
    ).toEqual({ state: "invalid" });
  });
});

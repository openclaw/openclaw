import { expect, it } from "vitest";
import { isPreDispatchToolCallRejectionMessage } from "./message-patterns.js";

it("keeps output-cap tool-call rejections pre-dispatch (#196544)", () => {
  expect(
    isPreDispatchToolCallRejectionMessage(
      "Provider completed stream with an incomplete tool call: output token limit reached (max_tokens 8192); raise the model's maxTokens",
    ),
  ).toBe(true);
  expect(
    isPreDispatchToolCallRejectionMessage("Provider completed stream with an incomplete tool call"),
  ).toBe(true);
});

import { describe, expect, it } from "vitest";
import { buildPayloads, expectSinglePayloadText } from "./payloads.test-helpers.js";

describe("buildEmbeddedRunPayloads GLM arg_key", () => {
  it("does not parse replyToId from suppressed internal context without a snapshot", () => {
    const payloads = buildPayloads({
      assistantTexts: [
        [
          "Visible",
          "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>",
          "[[reply_to:123]]",
          "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>",
        ].join("\n"),
      ],
    });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("Visible");
    expect(payloads[0]?.replyToId).toBeUndefined();
  });

  it("keeps a finished literal marker and strips a closed shadow block", () => {
    expectSinglePayloadText(
      buildPayloads({ assistantTexts: ["Use <tool_call>exec"] }),
      "Use <tool_call>exec",
    );
    expectSinglePayloadText(
      buildPayloads({
        assistantTexts: [
          "Visible\n<tool_call>exec<arg_key>command</arg_key><arg_value>echo redacted</arg_value></tool_call>\nDone.",
        ],
      }),
      "Visible\n\nDone.",
    );
  });
});

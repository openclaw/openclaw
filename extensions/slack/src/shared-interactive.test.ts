import { describe, expect, it } from "vitest";
import { buildSlackInteractiveBlocks } from "./shared-interactive.js";

describe("buildSlackInteractiveBlocks", () => {
  it("renders shared interactive blocks in authored order", () => {
    expect(
      buildSlackInteractiveBlocks({
        blocks: [
          {
            type: "select",
            placeholder: "Pick one",
            options: [{ label: "Alpha", value: "alpha" }],
          },
          { type: "text", text: "then" },
          { type: "buttons", buttons: [{ label: "Retry", value: "retry" }] },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        type: "actions",
        block_id: "openclaw_reply_select_1",
      }),
      expect.objectContaining({
        type: "section",
        text: expect.objectContaining({ text: "then" }),
      }),
      expect.objectContaining({
        type: "actions",
        block_id: "openclaw_reply_buttons_1",
      }),
    ]);
  });

  it("truncates Slack render strings to Block Kit limits", () => {
    const long = "x".repeat(120);
    const blocks = buildSlackInteractiveBlocks({
      blocks: [
        { type: "text", text: "y".repeat(3100) },
        { type: "select", placeholder: long, options: [{ label: long, value: long }] },
        { type: "buttons", buttons: [{ label: long, value: long }] },
      ],
    });
    const section = blocks[0] as { text?: { text?: string } };
    const selectBlock = blocks[1] as {
      elements?: Array<{ placeholder?: { text?: string } }>;
    };
    const buttonBlock = blocks[2] as {
      elements?: Array<{ value?: string }>;
    };

    expect((section.text?.text ?? "").length).toBeLessThanOrEqual(3000);
    expect((selectBlock.elements?.[0]?.placeholder?.text ?? "").length).toBeLessThanOrEqual(75);
    expect((buttonBlock.elements?.[0]?.value ?? "").length).toBeLessThanOrEqual(75);
  });
});

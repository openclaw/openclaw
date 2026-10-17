import { describe, expect, it } from "vitest";
import { adaptFeishuDirectCopyTextButtons } from "./channel-send.js";
import { buildFeishuPresentationCard } from "./presentation-card.js";

describe("Feishu copy-text presentation fallback", () => {
  it("keeps the exact value readable when native copy controls are unavailable", () => {
    const presentation = adaptFeishuDirectCopyTextButtons({
      blocks: [
        { type: "text", text: "Deployment ready" },
        {
          type: "buttons",
          buttons: [
            {
              label: "Copy command",
              action: { type: "copy-text", text: "openclaw status" },
            },
          ],
        },
      ],
    });

    expect(buildFeishuPresentationCard({ presentation }).body.elements).toEqual([
      { tag: "markdown", content: "Deployment ready" },
      {
        tag: "markdown",
        content: "<font color='grey'>Actions:\n- Copy command: `openclaw status`</font>",
      },
    ]);
  });
});

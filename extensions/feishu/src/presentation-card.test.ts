import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import { describe, expect, it } from "vitest";
import { buildFeishuPresentationCardElements } from "./presentation-card.js";

describe("buildFeishuPresentationCardElements", () => {
  it("renders table blocks through the portable text fallback", () => {
    const presentation = normalizeMessagePresentation({
      blocks: [
        {
          type: "table",
          caption: "Pipeline",
          headers: ["Account", "Stage", "ARR"],
          rows: [
            ["Acme", "Won", 125000],
            ["Globex", "Review", 82000],
          ],
        },
      ],
    });
    if (!presentation) {
      throw new Error("expected valid presentation");
    }

    expect(buildFeishuPresentationCardElements({ presentation })).toEqual([
      {
        tag: "markdown",
        content:
          "Pipeline (table)\n- Account: Acme; Stage: Won; ARR: 125000\n- Account: Globex; Stage: Review; ARR: 82000",
      },
    ]);
  });
});

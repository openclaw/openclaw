import { describe, expect, it } from "vitest";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";

describe("Slack copy-text presentation fallback", () => {
  it("keeps backticks and mentions literal when native copy controls are unavailable", () => {
    const content = renderSlackMessagePresentationFallbackText({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Copy",
                action: { type: "copy-text", text: "x`<!channel> <@U1>" },
              },
            ],
          },
        ],
      },
    });

    expect(content).toBe("- Copy [not copyable: contains backtick]: `x[backtick]<!channel> <@U1>`");
    expect([...content.matchAll(/`([^`]*)`/gs)]).toHaveLength(1);
    expect(content.replace(/`[^`]*`/gs, "")).not.toMatch(/<!channel>|<@U1>/);
  });
});

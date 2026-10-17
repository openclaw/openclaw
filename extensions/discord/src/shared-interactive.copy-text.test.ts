import { describe, expect, it } from "vitest";
import { buildDiscordPresentationComponents } from "./shared-interactive.js";

describe("Discord copy-text fallback boundary", () => {
  it("does not reinterpret an unadapted copy value as callback data", () => {
    expect(
      buildDiscordPresentationComponents({
        blocks: [
          {
            type: "buttons",
            buttons: [
              {
                label: "Copy token",
                action: { type: "copy-text", text: "TOKEN-7319" },
              },
            ],
          },
        ],
      }),
    ).toBeUndefined();
  });
});

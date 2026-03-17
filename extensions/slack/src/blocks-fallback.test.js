import { describe, expect, it } from "vitest";
import { buildSlackBlocksFallbackText } from "./blocks-fallback.js";
describe("buildSlackBlocksFallbackText", () => {
  it("prefers header text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "header", text: { type: "plain_text", text: "Deploy status" } }
      ])
    ).toBe("Deploy status");
  });
  it("uses image alt text", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "image", image_url: "https://example.com/image.png", alt_text: "Latency chart" }
      ])
    ).toBe("Latency chart");
  });
  it("uses generic defaults for file and unknown blocks", () => {
    expect(
      buildSlackBlocksFallbackText([
        { type: "file", source: "remote", external_id: "F123" }
      ])
    ).toBe("Shared a file");
    expect(buildSlackBlocksFallbackText([{ type: "divider" }])).toBe(
      "Shared a Block Kit message"
    );
  });
});

// Discord tests cover preview streaming mode resolution.
import { describe, expect, it } from "vitest";
import { resolveDiscordPreviewStreamMode } from "./preview-streaming.js";

describe("resolveDiscordPreviewStreamMode", () => {
  it("prefers a session streaming override before account config", () => {
    expect(
      resolveDiscordPreviewStreamMode({
        streaming: { mode: "partial" },
        sessionStreamingMode: "block",
      }),
    ).toBe("block");
  });

  it("keeps the Discord progress default when no config or session override is set", () => {
    expect(resolveDiscordPreviewStreamMode()).toBe("progress");
    expect(resolveDiscordPreviewStreamMode({ sessionStreamingMode: "bogus" })).toBe("progress");
  });
});

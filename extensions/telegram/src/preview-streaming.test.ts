import { describe, expect, it } from "vitest";
import { resolveTelegramBlockStreamingEnabled } from "./preview-streaming.js";

describe("resolveTelegramBlockStreamingEnabled", () => {
  it("lets an available explicit preview override the inherited block default", () => {
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: { streaming: { mode: "partial" } },
        previewAvailable: true,
        legacyBlockStreamingDefault: "on",
      }),
    ).toBe(false);
  });

  it("preserves the inherited block default when the turn cannot preview", () => {
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: { streaming: { mode: "partial" } },
        previewAvailable: false,
        legacyBlockStreamingDefault: "on",
      }),
    ).toBe(true);
  });

  it("preserves the inherited block default without an explicit preview mode", () => {
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: {},
        previewAvailable: true,
        legacyBlockStreamingDefault: "on",
      }),
    ).toBe(true);
  });

  it("keeps explicit block configuration authoritative", () => {
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: { streaming: { mode: "partial", block: { enabled: true } } },
        previewAvailable: true,
        legacyBlockStreamingDefault: "off",
      }),
    ).toBe(true);
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: { streaming: { mode: "off", block: { enabled: false } } },
        previewAvailable: false,
        legacyBlockStreamingDefault: "on",
      }),
    ).toBe(false);
  });

  it("lets off mode inherit the block default", () => {
    expect(
      resolveTelegramBlockStreamingEnabled({
        account: { streaming: { mode: "off" } },
        previewAvailable: false,
        legacyBlockStreamingDefault: "on",
      }),
    ).toBe(true);
  });
});

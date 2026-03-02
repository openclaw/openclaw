import { describe, expect, it } from "vitest";
import { telegramUserbotStreamingAdapter } from "./streaming.js";

describe("telegramUserbotStreamingAdapter", () => {
  it("provides block streaming coalesce defaults", () => {
    expect(telegramUserbotStreamingAdapter.blockStreamingCoalesceDefaults).toEqual({
      minChars: 1500,
      idleMs: 1000,
    });
  });
});

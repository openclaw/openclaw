import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";

describe("Telegram channel plugin meta", () => {
  it("enables session lookup for announce targets", () => {
    expect(telegramPlugin.meta.preferSessionLookupForAnnounceTarget).toBe(true);
  });
});

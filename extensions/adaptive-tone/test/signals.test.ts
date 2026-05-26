import { describe, expect, it } from "vitest";
import { normalizeConfig } from "../src/config.js";
import {
  channelRegister,
  countRepeats,
  detectUnwell,
  extractUserTexts,
  normalizeText,
  similarity,
  timeBucket,
} from "../src/signals.js";

const cfg = normalizeConfig({});

describe("timeBucket", () => {
  it("buckets hours of day", () => {
    const at = (h: number) => new Date(2026, 0, 1, h, 0, 0);
    expect(timeBucket(at(6))).toBe("early-morning");
    expect(timeBucket(at(12))).toBe("day");
    expect(timeBucket(at(20))).toBe("evening");
    expect(timeBucket(at(23))).toBe("late-night");
    expect(timeBucket(at(3))).toBe("late-night");
  });

  it("respects an IANA timezone", () => {
    // 23:00 UTC is 00:00 in Berlin (UTC+1, no DST in January) → late-night.
    const utc2300 = new Date(Date.UTC(2026, 0, 1, 23, 0, 0));
    expect(timeBucket(utc2300, "Europe/Berlin")).toBe("late-night");
    // 09:00 UTC is 10:00 in Berlin → day.
    const utc0900 = new Date(Date.UTC(2026, 0, 1, 9, 0, 0));
    expect(timeBucket(utc0900, "Europe/Berlin")).toBe("day");
  });

  it("falls back to local time on a bad timezone", () => {
    const d = new Date(2026, 0, 1, 12, 0, 0);
    expect(timeBucket(d, "Not/AZone")).toBe("day");
  });
});

describe("channelRegister", () => {
  it("maps known professional and casual channels", () => {
    expect(channelRegister("slack", cfg)).toBe("professional");
    expect(channelRegister("whatsapp", cfg)).toBe("casual");
  });

  it("handles composite channel ids by leading segment", () => {
    expect(channelRegister("slack:T123/C456", cfg)).toBe("professional");
    expect(channelRegister("telegram:99", cfg)).toBe("casual");
  });

  it("is neutral for unknown or missing channels", () => {
    expect(channelRegister("irc", cfg)).toBe("neutral");
    expect(channelRegister(undefined, cfg)).toBe("neutral");
  });
});

describe("text normalization + similarity", () => {
  it("normalizes punctuation and case", () => {
    expect(normalizeText("How DO I, reset?!")).toBe("how do i reset");
  });

  it("scores identical strings as 1 and disjoint as 0", () => {
    expect(similarity("reset my password", "reset my password")).toBe(1);
    expect(similarity("reset my password", "deploy the server")).toBe(0);
  });
});

describe("extractUserTexts", () => {
  it("pulls string and array-content user turns, ignoring assistant turns", () => {
    const messages = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ignored" },
      { role: "user", content: [{ type: "text", text: "second" }, { type: "image" }] },
      "garbage",
      null,
    ];
    expect(extractUserTexts(messages)).toEqual(["first", "second"]);
  });
});

describe("countRepeats", () => {
  it("counts near-identical prior asks within the window", () => {
    const messages = [
      { role: "user", content: "how do I reset my password" },
      { role: "assistant", content: "..." },
      { role: "user", content: "how do i reset my password!!" },
      { role: "assistant", content: "..." },
    ];
    // Two prior matching asks → current is the 3rd time.
    expect(countRepeats("how do I reset my password", messages, cfg)).toBe(2);
  });

  it("returns 0 when nothing matches", () => {
    const messages = [{ role: "user", content: "what is the weather" }];
    expect(countRepeats("deploy the staging server", messages, cfg)).toBe(0);
  });
});

describe("detectUnwell", () => {
  it("matches explicit, user-volunteered distress phrases", () => {
    expect(detectUnwell("hey, I'm not well today, can you help", cfg)).toBe(true);
    expect(detectUnwell("had a really rough day honestly", cfg)).toBe(true);
  });

  it("does not match neutral messages", () => {
    expect(detectUnwell("can you summarise this report", cfg)).toBe(false);
  });
});

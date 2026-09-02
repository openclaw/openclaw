// Telegram tests cover dice extraction from inbound messages.
import type { Message } from "grammy/types";
import { describe, expect, it } from "vitest";
import { extractTelegramDice, formatTelegramDiceText } from "./body-helpers.js";

function diceMessage(dice: unknown): Pick<Message, "dice"> {
  return { dice } as Pick<Message, "dice">;
}

describe("extractTelegramDice", () => {
  it("extracts emoji and value from a dice roll", () => {
    expect(extractTelegramDice(diceMessage({ emoji: "🎲", value: 4 }))).toEqual({
      emoji: "🎲",
      value: 4,
    });
  });

  it("extracts the wider slot-machine range", () => {
    expect(extractTelegramDice(diceMessage({ emoji: "🎰", value: 64 }))).toEqual({
      emoji: "🎰",
      value: 64,
    });
  });

  it("returns null when the message carries no dice", () => {
    expect(extractTelegramDice(diceMessage(undefined))).toBeNull();
  });

  it("returns null when the value is missing or not finite", () => {
    expect(extractTelegramDice(diceMessage({ emoji: "🎲" }))).toBeNull();
    expect(extractTelegramDice(diceMessage({ emoji: "🎲", value: Number.NaN }))).toBeNull();
  });

  it("returns null when the emoji is blank", () => {
    expect(extractTelegramDice(diceMessage({ emoji: "   ", value: 3 }))).toBeNull();
  });

  it("keeps a zero value rather than treating it as absent", () => {
    expect(extractTelegramDice(diceMessage({ emoji: "🎯", value: 0 }))).toEqual({
      emoji: "🎯",
      value: 0,
    });
  });
});

describe("formatTelegramDiceText", () => {
  it("renders a stable one-line marker", () => {
    expect(formatTelegramDiceText({ emoji: "🎲", value: 2 })).toBe("[Dice 🎲 = 2]");
  });

  it("keeps one line for the widest value", () => {
    expect(formatTelegramDiceText({ emoji: "🎰", value: 64 })).toBe("[Dice 🎰 = 64]");
  });
});

import { describe, expect, it } from "vitest";
import { normalizeModifiers, parseKeyChord, scalePoint } from "./actions.js";

// normalizeKey is internal; exercise it through parseKeyChord's final segment.
const normalizeKey = (input: string) => parseKeyChord(input, "linux").key;

describe("cua-computer key normalization", () => {
  it.each([
    ["Super+Control+Option", "linux", ["meta", "ctrl", "alt"]],
    ["win+mod1", "darwin", ["cmd", "alt"]],
  ] as const)("normalizes modifier aliases in %s on %s", (input, platform, expected) => {
    expect(normalizeModifiers(input, platform)).toEqual(expected);
  });

  it.each([
    ["Esc", "escape"],
    ["F12", "f12"],
    ["Z", "z"],
  ])("normalizes key %s", (input, expected) => {
    expect(normalizeKey(input)).toBe(expected);
  });

  it("rejects punctuation aliases toward the type action", () => {
    expect(() => normalizeKey("minus")).toThrow("COMPUTER_UNSUPPORTED_KEY");
  });

  it("keeps letter keys usable in shortcut chords", () => {
    expect(parseKeyChord("cmd+c", "linux")).toEqual({ key: "c", modifiers: ["meta"] });
  });

  // Digits and punctuation are shifted on some keyboard layouts, and cua-driver
  // drops that shift state, so they must be rejected toward the type action
  // rather than silently degraded.
  it.each(["1", "+", "?", "é"])("rejects layout-shifted key %s toward the type action", (input) => {
    expect(() => normalizeKey(input)).toThrow("COMPUTER_UNSUPPORTED_KEY");
  });

  it("keeps rounded coordinates inside the native primary-display bounds", () => {
    expect(
      scalePoint(
        {
          id: "frame",
          referenceWidth: 1920,
          nativeWidth: 3840,
          nativeHeight: 2160,
          deliveredWidth: 1920,
          deliveredHeight: 1080,
          geometry: { width: 3840, height: 2160, scaleFactor: 1 },
        },
        1919.9,
        1079.9,
        "click",
      ),
    ).toEqual({ x: 3839, y: 2159 });
  });
});

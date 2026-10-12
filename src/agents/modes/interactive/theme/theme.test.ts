import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../../test/helpers/temp-dir.js";
import darkTheme from "./dark.json" with { type: "json" };
import { loadThemeFromPath } from "./theme.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function loadColor(color: string | number, mode: "256color" | "truecolor") {
  const themePath = join(tempDirs.make("openclaw-theme-"), "theme.json");
  writeFileSync(
    themePath,
    JSON.stringify({
      ...darkTheme,
      colors: { ...darkTheme.colors, accent: color, selectedBg: color },
    }),
  );
  return loadThemeFromPath(themePath, mode);
}

describe("loadThemeFromPath", () => {
  it.each([
    ["#0000ff", 21],
    ["#2f00ff", 21],
    ["#3000ff", 57],
    ["#7300ff", 57],
    ["#7400ff", 93],
    ["#ff7300", 202],
    ["#ff7400", 208],
    ["#00ff73", 47],
    ["#00ff74", 48],
    ["#5f87af", 67],
    ["#000000", 16],
    ["#040404", 16],
    ["#050505", 232],
    ["#0d0d0d", 232],
    ["#0e0e0e", 233],
    ["#ffffff", 231],
    ["#606060", 59],
    ["#616161", 241],
    ["#0c0d0e", 232],
    ["#0d0d16", 233],
    ["#0d0d17", 16],
  ])(
    "renders %s as palette index %i with separate foreground/background resets",
    (color, index) => {
      const theme = loadColor(color, "256color");
      expect(theme.fg("accent", "text")).toBe(`\x1b[38;5;${index}mtext\x1b[39m`);
      expect(theme.bg("selectedBg", "text")).toBe(`\x1b[48;5;${index}mtext\x1b[49m`);
    },
  );

  it("preserves RGB channels in truecolor output", () => {
    const theme = loadColor("#5f87af", "truecolor");
    expect(theme.getFgAnsi("accent")).toBe("\x1b[38;2;95;135;175m");
    expect(theme.getBgAnsi("selectedBg")).toBe("\x1b[48;2;95;135;175m");
    expect(theme.fg("accent", "text")).toBe("\x1b[38;2;95;135;175mtext\x1b[39m");
    expect(theme.bg("selectedBg", "text")).toBe("\x1b[48;2;95;135;175mtext\x1b[49m");
  });

  it.each(["256color", "truecolor"] as const)(
    "preserves numeric and reset colors in %s",
    (mode) => {
      for (const index of [0, 123, 255]) {
        const theme = loadColor(index, mode);
        expect(theme.getFgAnsi("accent")).toBe(`\x1b[38;5;${index}m`);
        expect(theme.getBgAnsi("selectedBg")).toBe(`\x1b[48;5;${index}m`);
        expect(theme.fg("accent", "text")).toBe(`\x1b[38;5;${index}mtext\x1b[39m`);
        expect(theme.bg("selectedBg", "text")).toBe(`\x1b[48;5;${index}mtext\x1b[49m`);
      }
      const reset = loadColor("", mode);
      expect(reset.getFgAnsi("accent")).toBe("\x1b[39m");
      expect(reset.getBgAnsi("selectedBg")).toBe("\x1b[49m");
      expect(reset.fg("accent", "text")).toBe("\x1b[39mtext\x1b[39m");
      expect(reset.bg("selectedBg", "text")).toBe("\x1b[49mtext\x1b[49m");
    },
  );

  it.each([
    ["fg", /^Unknown theme color: missing$/],
    ["getFgAnsi", /^Unknown theme color: missing$/],
    ["bg", /^Unknown theme background color: missing$/],
    ["getBgAnsi", /^Unknown theme background color: missing$/],
  ] as const)("rejects unknown colors through %s", (method, message) => {
    const theme = loadColor(123, "256color");
    expect(() => Reflect.apply(theme[method], theme, ["missing", "text"])).toThrow(message);
  });

  it("keeps formatting independent of supplied raw ANSI getter overrides", () => {
    const theme = loadColor(123, "256color");
    theme.getFgAnsi = () => "\x1b[31m";
    theme.getBgAnsi = () => "\x1b[41m";
    expect(theme.getFgAnsi("accent")).toBe("\x1b[31m");
    expect(theme.getBgAnsi("selectedBg")).toBe("\x1b[41m");
    expect(theme.fg("accent", "text")).toBe("\x1b[38;5;123mtext\x1b[39m");
    expect(theme.bg("selectedBg", "text")).toBe("\x1b[48;5;123mtext\x1b[49m");
  });
});

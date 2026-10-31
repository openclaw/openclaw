import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setCapabilityOverrides } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../../test/helpers/temp-dir.js";
import darkTheme from "./dark.json" with { type: "json" };
import { loadThemeFromPath } from "./theme.js";

afterEach(() => setCapabilityOverrides({}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function loadColor(
  color: string | number | Record<string, string | number | undefined>,
  mode: "256color" | "truecolor" = "256color",
) {
  const colors = typeof color === "object" ? color : { accent: color, selectedBg: color };
  const themePath = join(tempDirs.make("openclaw-theme-"), "theme.json");
  const json = JSON.stringify({ ...darkTheme, colors: { ...darkTheme.colors, ...colors } });
  writeFileSync(themePath, json);
  setCapabilityOverrides({ trueColor: mode === "truecolor" });
  return loadThemeFromPath(themePath);
}

function expectColors(theme: ReturnType<typeof loadColor>, fg: string, bg: string) {
  expect(theme.getFgAnsi("accent")).toBe(fg);
  expect(theme.getBgAnsi("selectedBg")).toBe(bg);
  expect(theme.fg("accent", "text")).toBe(`${fg}text\x1b[39m`);
  expect(theme.bg("selectedBg", "text")).toBe(`${bg}text\x1b[49m`);
}

describe("loadThemeFromPath", () => {
  it("preserves missing-color repair guidance", () => {
    expect(() => loadColor({ thinkingXhigh: undefined })).toThrow(
      'Missing required color tokens:\n  - thinkingXhigh\n\nPlease add these colors to your theme\'s "colors" object.',
    );
  });

  it("reports invalid numeric palette values at their color path", () => {
    expect(() => loadColor({ accent: 256 })).toThrow("/colors/accent");
  });

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
  ])("renders %s as palette %i with layer-specific resets", (color, index) => {
    const theme = loadColor(color, "256color");
    expect(theme.fg("accent", "text")).toBe(`\x1b[38;5;${index}mtext\x1b[39m`);
    expect(theme.bg("selectedBg", "text")).toBe(`\x1b[48;5;${index}mtext\x1b[49m`);
  });

  it("preserves RGB channels in truecolor output", () => {
    const theme = loadColor("#5f87af", "truecolor");
    expectColors(theme, "\x1b[38;2;95;135;175m", "\x1b[48;2;95;135;175m");
  });

  it.each(["256color", "truecolor"] as const)("renders numbers and resets in %s", (mode) => {
    for (const index of [0, 123, 255]) {
      expectColors(loadColor(index, mode), `\x1b[38;5;${index}m`, `\x1b[48;5;${index}m`);
    }
    expectColors(loadColor("", mode), "\x1b[39m", "\x1b[49m");
  });

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
    expect(theme.fg("accent", "text")).toBe("\x1b[38;5;123mtext\x1b[39m");
    expect(theme.bg("selectedBg", "text")).toBe("\x1b[48;5;123mtext\x1b[49m");
  });
});

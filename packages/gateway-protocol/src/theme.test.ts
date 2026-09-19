import { describe, expect, it } from "vitest";
import {
  createThemeDefinitionFixture,
  createThemePaletteFixture,
} from "../../../test/helpers/theme-fixture.js";
import {
  isThemeId,
  normalizeThemeDefinition,
  normalizeThemeMode,
  parseThemeDefinition,
  THEME_COLOR_KEYS,
} from "./theme.js";

describe("portable theme definition", () => {
  it("normalizes a complete dark-only palette and preserves supported color formats", () => {
    const definition = normalizeThemeDefinition(
      createThemeDefinitionFixture({
        name: " Xenovessel ",
        dark: createThemePaletteFixture({
          background: "oklch(15% 0.04 280deg)",
          foreground: "hsl(240 20% 95% / 0.9)",
          primary: "rgb(180, 255, 40)",
          accent: "color(display-p3 0.2 0.9 1)",
        }),
      }),
    );
    expect(definition.name).toBe("Xenovessel");
    expect(definition.light).toBeUndefined();
    expect(definition.dark?.accent).toBe("color(display-p3 0.2 0.9 1)");
  });

  it.each([
    { background: 'url("https://example.invalid/pixel")' },
    { background: "#000;display:none" },
    { background: "var(--other-theme)" },
    { background: "rgb()" },
    { background: "red/* hidden */" },
    { "font-sans": "monospace; background: url(https://example.invalid)" },
    { "font-sans": "var(--font-body)" },
  ])("rejects executable or dependent CSS values %j", (palette) => {
    expect(
      parseThemeDefinition(
        createThemeDefinitionFixture({ dark: createThemePaletteFixture(palette) }),
      ),
    ).toBeNull();
  });

  it("rejects missing modes, incomplete palettes, unknown properties, and oversized stored values", () => {
    const { background: _background, ...incomplete } = createThemePaletteFixture();
    expect(() => normalizeThemeDefinition({ name: "Empty", description: "No colors" })).toThrow(
      "at least one",
    );
    expect(() =>
      normalizeThemeDefinition({ ...createThemeDefinitionFixture(), dark: incomplete }),
    ).toThrow("background");
    expect(() =>
      normalizeThemeDefinition({ ...createThemeDefinitionFixture(), css: "body {}" }),
    ).toThrow("unsupported field");
    const longColor = `rgb(0.${"1".repeat(85)} 0 0)`;
    const palette = createThemePaletteFixture(
      Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, longColor])),
    );
    expect(() =>
      normalizeThemeDefinition(createThemeDefinitionFixture({ light: palette, dark: palette })),
    ).toThrow("4096 bytes");
  });

  it.each([
    ["claw", true],
    ["rose", true],
    ["custom", false],
    ["space/neon", true],
    ["pack/one/neon", true],
    ["Space/Entry/neon", true],
    ["@scope/Pack/neon", true],
    ["@scope/Pack/Entry/neon", true],
    ["user/xenovessel", true],
    ["space/../neon", false],
    ["space/./neon", false],
    ["space//neon", false],
    ["space\\entry/neon", false],
    ["space/entry/Neon", false],
    ["user/neon/more", false],
    [`${"a".repeat(251)}/neon`, true],
    [`${"a".repeat(252)}/neon`, false],
  ])("validates catalog identity %s", (id, expected) => {
    expect(isThemeId(id)).toBe(expected);
  });
});

it.each([
  ["system", "system"],
  ["light", "light"],
  ["dark", "dark"],
  ["DARK", undefined],
  [" light ", undefined],
  ["", undefined],
  [null, undefined],
  [undefined, undefined],
  [0, undefined],
  [false, undefined],
  [[], undefined],
  [{ mode: "light" }, undefined],
])("normalizes only exact theme mode literals: %j", (input, expected) => {
  expect(normalizeThemeMode(input)).toBe(expected);
});

import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  createThemeDefinitionFixture,
  createThemePaletteFixture,
} from "../../../test/helpers/theme-fixture.js";
import { ThemesImportParamsSchema } from "./schema/themes.js";
import {
  isThemeId,
  normalizeThemeDefinition,
  normalizeThemeMode,
  parseThemeDefinition,
  resolveThemeBranding,
  THEME_COLOR_KEYS,
  type ThemePalette,
} from "./theme.js";

function createDarkTheme(palette: Partial<ThemePalette>) {
  return createThemeDefinitionFixture({ dark: createThemePaletteFixture(palette) });
}

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
    expect(definition).not.toHaveProperty("mascot");
    expect(definition).not.toHaveProperty("workingPhrases");
    expect(definition).not.toHaveProperty("critters");
    expect(definition).not.toHaveProperty("avatarHat");
  });

  it.each(["claw", "none"] as const)(
    "accepts the %s mascot, authored critters and hat, and normalizes custom working phrases",
    (mascot) => {
      expect(
        normalizeThemeDefinition(
          createThemeDefinitionFixture({
            mascot,
            workingPhrases: [" Building ", "x".repeat(24)],
            critters: ["fedora", "penguin"],
            avatarHat: "fedora",
          }),
        ),
      ).toMatchObject({
        mascot,
        workingPhrases: ["Building", "x".repeat(24)],
        critters: ["fedora", "penguin"],
        avatarHat: "fedora",
      });
    },
  );

  it.each([
    { workingPhrases: [] },
    { workingPhrases: Array.from({ length: 24 }, (_, index) => `Working ${index}`) },
  ])("accepts working phrases at the entry-count boundaries: %j", ({ workingPhrases }) => {
    expect(
      normalizeThemeDefinition(createThemeDefinitionFixture({ workingPhrases })).workingPhrases,
    ).toEqual(workingPhrases);
  });

  it("accepts an explicitly empty critter list", () => {
    expect(
      normalizeThemeDefinition(createThemeDefinitionFixture({ critters: [] })).critters,
    ).toEqual([]);
  });

  it("accepts a built-in avatar hat in portable definitions and import requests", () => {
    const definition = createThemeDefinitionFixture({ avatarHat: "crown" });
    expect(normalizeThemeDefinition(definition).avatarHat).toBe("crown");
    expect(Value.Check(ThemesImportParamsSchema, { id: "hat-theme", definition })).toBe(true);
  });

  it.each(["beanie", null])(
    "keeps undeclared avatar hat %j out of personal definitions",
    (avatarHat) => {
      const definition = { ...createThemeDefinitionFixture(), avatarHat };
      expect(() => normalizeThemeDefinition(definition)).toThrow(
        "theme.avatarHat must be one of fedora, crown, santa, party, pumpkin",
      );
      expect(Value.Check(ThemesImportParamsSchema, { id: "hat-theme", definition })).toBe(
        avatarHat !== null,
      );
    },
  );

  it("accepts plugin artwork only from declared IDs of the corresponding kind", () => {
    const definition = createThemeDefinitionFixture({ avatarHat: "beret", critters: ["ferris"] });
    expect(() => normalizeThemeDefinition(definition)).toThrow(
      "theme.critters[0] must be one of penguin, fedora",
    );
    expect(() =>
      normalizeThemeDefinition(definition, { hatIds: ["ferris"], critterIds: ["beret"] }),
    ).toThrow("theme.critters[0]");
    expect(
      normalizeThemeDefinition(definition, { hatIds: ["beret"], critterIds: ["ferris"] }),
    ).toMatchObject({ avatarHat: "beret", critters: ["ferris"] });
    expect(Value.Check(ThemesImportParamsSchema, { id: "hat-theme", definition })).toBe(true);
    expect(parseThemeDefinition(definition)).toBeNull();
  });

  it.each(["", "Beret", "a".repeat(33), "beret.svg", "<svg>"])(
    "rejects nonportable artwork ID %j at the wire boundary",
    (id) => {
      for (const branding of [{ avatarHat: id }, { critters: [id] }]) {
        expect(
          Value.Check(ThemesImportParamsSchema, {
            id: "hat-theme",
            definition: createThemeDefinitionFixture(branding),
          }),
        ).toBe(false);
      }
    },
  );

  it.each([
    [{ mascot: "robot" }, "theme.mascot must be one of claw, none"],
    [{ workingPhrases: "Building" }, "must be an array"],
    [
      { workingPhrases: Array.from({ length: 25 }, (_, index) => `Working ${index}`) },
      "at most 24 entries",
    ],
    [{ workingPhrases: ["x".repeat(25)] }, "at most 24 characters"],
    [{ workingPhrases: ["Building", " Building "] }, "duplicate entries after trimming"],
    [{ workingPhrases: [" "] }, "nonempty text"],
    [{ workingPhrases: ["Build\ning"] }, "nonempty text"],
    [{ workingPhrases: ["Building\u007f"] }, "nonempty text"],
    [{ critters: "penguin" }, "theme.critters must be an array"],
    [{ critters: Array.from({ length: 9 }, () => "penguin") }, "at most 8 entries"],
    [{ critters: ["penguin", "penguin"] }, "duplicate entries"],
    [{ critters: [" Penguin "] }, "theme.critters[0] must be one of penguin, fedora"],
  ])("rejects invalid branding %j", (fields, message) => {
    expect(() =>
      normalizeThemeDefinition({ ...createThemeDefinitionFixture(), ...fields }),
    ).toThrow(message);
  });

  it.each([
    { background: "#000;display:none" },
    { background: "var(--other-theme)" },
    { background: "rgb()" },
    { background: "rgb(1, 2 3)" },
    { background: "rgb(1 2, 3)" },
    { background: "rgb(1, 2, 3 / .5)" },
    { background: "rgb(1%, 2, 3%)" },
    { background: "rgb(1. 2 3)" },
    { background: "rgb(1\u00a02\u00a03)" },
    { background: "hsl(180, 40, 50)" },
    { background: "hsl(180 40% 50% .5)" },
    { background: "lab(50%, 20, 10)" },
    { background: "color(srgb\u00a00 0 0)" },
    { background: "red/* hidden */" },
    { "font-sans": "var(--font-body)" },
    { "font-sans": "Roboto,,monospace" },
    { "font-sans": "123Font" },
    { "font-sans": "Foo.Bar" },
    { "font-sans": "-1font" },
    { "font-sans": "serif Foo" },
    { "font-sans": "Foo serif" },
    { "font-sans": "Foo inherit" },
    { "font-sans": "default Foo" },
    { "font-sans": "default" },
    { "font-sans": "-webkit-body Foo" },
  ])("rejects unsafe or malformed CSS values %j", (palette) => {
    expect(parseThemeDefinition(createDarkTheme(palette))).toBeNull();
  });

  it.each([
    "rgb(1 2 3)",
    "rgb(1e2 2 3)",
    "rgb(1% 2 3% / 50%)",
    "rgba(1, 2, 3, .5)",
    "rgb(1%, 2%, 3%, 50%)",
    "hsl(180 40 50 / .5)",
    "hsla(0.5turn, 40%, 50%, .5)",
    "lab(50% -20 10 / .5)",
    "lch(50% 20 180deg)",
    "oklab(50% -.2 .1 / 50%)",
    "oklch(50% 0.2 180)",
    "color(display-p3 .1 .2 .3 / .5)",
  ])("preserves supported color syntax: %s", (background) => {
    expect(normalizeThemeDefinition(createDarkTheme({ background })).dark?.background).toBe(
      background,
    );
  });

  it.each([
    "JetBrains Mono, monospace",
    "'A,B', monospace",
    "\"A'B\", 'C\"D'",
    '"123 Font", monospace',
    "'serif Foo', 'Foo serif', 'Foo inherit', 'default Foo', 'default', 'inherit'",
    "--font, Foo_Bar",
    '""',
  ])("preserves font family names: %s", (font) => {
    expect(
      normalizeThemeDefinition(createDarkTheme({ "font-sans": font })).dark?.["font-sans"],
    ).toBe(font);
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
    ["custom", false],
    ["@scope/Pack/Entry/neon", true],
    ["user/xenovessel", true],
    ["space/../neon", false],
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

it("resolves omitted branding to the claw without critters or a hat and retains authored branding", () => {
  const defaults = {
    mascot: "claw",
    workingPhrases: undefined,
    critters: [],
    avatarHat: undefined,
  };
  expect(resolveThemeBranding(undefined)).toEqual(defaults);
  expect(resolveThemeBranding({})).toEqual(defaults);
  expect(resolveThemeBranding({ workingPhrases: [] })).toEqual({
    ...defaults,
    workingPhrases: [],
  });
  expect(
    resolveThemeBranding({
      mascot: "none",
      workingPhrases: ["Building"],
      critters: ["penguin", "fedora"],
      avatarHat: "fedora",
    }),
  ).toEqual({
    mascot: "none",
    workingPhrases: ["Building"],
    critters: ["penguin", "fedora"],
    avatarHat: "fedora",
  });
});

it.each([
  ["system", "system"],
  ["light", "light"],
  ["dark", "dark"],
  ["DARK", undefined],
  [" light ", undefined],
  [null, undefined],
])("normalizes only exact theme mode literals: %j", (input, expected) => {
  expect(normalizeThemeMode(input)).toBe(expected);
});

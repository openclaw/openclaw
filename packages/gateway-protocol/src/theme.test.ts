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

  it.each(["fedora", "crown", "santa", "party", "pumpkin"] as const)(
    "accepts the %s avatar hat in portable definitions and import requests",
    (avatarHat) => {
      const definition = createThemeDefinitionFixture({ avatarHat });
      expect(normalizeThemeDefinition(definition).avatarHat).toBe(avatarHat);
      expect(Value.Check(ThemesImportParamsSchema, { id: "hat-theme", definition })).toBe(true);
    },
  );

  it.each(["beanie", "monocle", "sprout", "patch", "barnacle", null])(
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
    { fields: { mascot: "robot" }, message: "theme.mascot must be one of claw, none" },
    { fields: { workingPhrases: "Building" }, message: "must be an array" },
    {
      fields: { workingPhrases: Array.from({ length: 25 }, (_, index) => `Working ${index}`) },
      message: "at most 24 entries",
    },
    { fields: { workingPhrases: ["x".repeat(25)] }, message: "at most 24 characters" },
    {
      fields: { workingPhrases: ["Building", " Building "] },
      message: "duplicate entries after trimming",
    },
    { fields: { workingPhrases: [" "] }, message: "nonempty text" },
    { fields: { workingPhrases: ["Build\ning"] }, message: "nonempty text" },
    { fields: { workingPhrases: ["Building\u007f"] }, message: "nonempty text" },
    { fields: { critters: "penguin" }, message: "theme.critters must be an array" },
    {
      fields: { critters: Array.from({ length: 9 }, () => "penguin") },
      message: "at most 8 entries",
    },
    { fields: { critters: ["penguin", "penguin"] }, message: "duplicate entries" },
    {
      fields: { critters: ["robot"] },
      message: "theme.critters[0] must be one of penguin, fedora",
    },
    {
      fields: { critters: [" Penguin "] },
      message: "theme.critters[0] must be one of penguin, fedora",
    },
  ])("rejects invalid branding $fields", ({ fields, message }) => {
    expect(() =>
      normalizeThemeDefinition({ ...createThemeDefinitionFixture(), ...fields }),
    ).toThrow(message);
  });

  it.each([
    { background: 'url("https://example.invalid/pixel")' },
    { background: "#000;display:none" },
    { background: "var(--other-theme)" },
    { background: "rgb()" },
    { background: "rgb(1 2 3 .5)" },
    { background: "rgb(1, 2 3)" },
    { background: "rgb(1 2, 3)" },
    { background: "rgb(1, 2, 3 / .5)" },
    { background: "rgb(1%, 2, 3%)" },
    { background: "rgb(1. 2 3)" },
    { background: "rgb(1\u00a02\u00a03)" },
    { background: "hsl(180, 40, 50)" },
    { background: "hsl(180 40% 50% .5)" },
    { background: "oklch(50%, 0.2, 180)" },
    { background: "lab(50%, 20, 10)" },
    { background: "color(srgb\u00a00 0 0)" },
    { background: "red/* hidden */" },
    { "font-sans": "monospace; background: url(https://example.invalid)" },
    { "font-sans": "var(--font-body)" },
    { "font-sans": "'unterminated" },
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
    expect(
      parseThemeDefinition(
        createThemeDefinitionFixture({ dark: createThemePaletteFixture(palette) }),
      ),
    ).toBeNull();
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
    expect(
      normalizeThemeDefinition(
        createThemeDefinitionFixture({ dark: createThemePaletteFixture({ background }) }),
      ).dark?.background,
    ).toBe(background);
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
      normalizeThemeDefinition(
        createThemeDefinitionFixture({ dark: createThemePaletteFixture({ "font-sans": font }) }),
      ).dark?.["font-sans"],
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

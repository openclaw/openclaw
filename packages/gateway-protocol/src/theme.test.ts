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
  it.each(["none"] as const)(
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

  it.each(["none"] as const)(
    "accepts independent branding with the %s working indicator",
    (workingIndicator) => {
      const fields = {
        brandName: "Mission Control",
        brandIcon: "mark",
        workingIndicator,
        lobsterdex: false,
        communityLinks: false,
      };
      const definition = createThemeDefinitionFixture(fields);
      expect(
        normalizeThemeDefinition({ ...definition, brandName: " Mission Control " }),
      ).toMatchObject(fields);
      expect(Value.Check(ThemesImportParamsSchema, { id: "mission", definition })).toBe(true);
      expect(
        normalizeThemeDefinition({ ...definition, brandName: "a".repeat(80) }).brandName,
      ).toHaveLength(80);
    },
  );

  it("restricts custom brand icons to the manifest's icon IDs", () => {
    const definition = createThemeDefinitionFixture({ brandIcon: "rocket" });
    expect(() => normalizeThemeDefinition(definition)).toThrow("theme.brandIcon");
    expect(() =>
      normalizeThemeDefinition(definition, { hatIds: ["rocket"], critterIds: ["rocket"] }),
    ).toThrow("theme.brandIcon");
    expect(normalizeThemeDefinition(definition, { iconIds: ["rocket"] }).brandIcon).toBe("rocket");
    expect(parseThemeDefinition(definition)).toBeNull();
  });

  it.each([null])("keeps undeclared avatar hat %j out of personal definitions", (avatarHat) => {
    const definition = { ...createThemeDefinitionFixture(), avatarHat };
    expect(() => normalizeThemeDefinition(definition)).toThrow(
      "theme.avatarHat must be one of fedora, crown, santa, party, pumpkin",
    );
    expect(Value.Check(ThemesImportParamsSchema, { id: "hat-theme", definition })).toBe(
      avatarHat !== null,
    );
  });

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

  it.each(["<svg>"])("rejects nonportable artwork ID %j at the wire boundary", (id) => {
    for (const branding of [{ brandIcon: id }, { avatarHat: id }, { critters: [id] }]) {
      expect(
        Value.Check(ThemesImportParamsSchema, {
          id: "hat-theme",
          definition: createThemeDefinitionFixture(branding),
        }),
      ).toBe(false);
    }
  });

  it.each<[Record<string, unknown>, string]>([
    [{ brandName: "hello\ud800" }, "theme.brandName"],
    [{ workingIndicator: "spinner" }, "theme.workingIndicator"],
    [{ lobsterdex: "false" }, "theme.lobsterdex"],
    [{ mascot: "robot" }, "theme.mascot must be one of claw, none"],
    [
      { workingPhrases: Array.from({ length: 25 }, (_, index) => `Working ${index}`) },
      "at most 24 entries",
    ],
    [{ workingPhrases: ["Building", " Building "] }, "duplicate entries after trimming"],
    [{ critters: Array.from({ length: 9 }, () => "penguin") }, "at most 8 entries"],
    [{ critters: ["penguin", "penguin"] }, "duplicate entries"],
  ])("rejects invalid branding %j", (fields, message) => {
    expect(() =>
      normalizeThemeDefinition({ ...createThemeDefinitionFixture(), ...fields }),
    ).toThrow(message);
  });

  it.each([
    { background: "#000;display:none" },
    { background: "var(--other-theme)" },
    { "font-sans": "var(--font-body)" },
    { "font-sans": "Foo serif" },
    { "font-sans": "default" },
  ])("rejects unsafe or malformed CSS values %j", (palette) => {
    expect(parseThemeDefinition(createDarkTheme(palette))).toBeNull();
  });

  it.each(["JetBrains Mono, monospace"])("preserves font family names: %s", (font) => {
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
    ["user/xenovessel", true],
    ["space/../neon", false],
    [`${"a".repeat(252)}/neon`, false],
  ])("validates catalog identity %s", (id, expected) => {
    expect(isThemeId(id)).toBe(expected);
  });
});

it("resolves omitted branding to the claw without critters or a hat and retains authored branding", () => {
  const defaults = {
    mascot: "claw",
    brandName: "OpenClaw",
    brandIcon: "claw",
    workingIndicator: "claw",
    lobsterdex: true,
    communityLinks: true,
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
    ...defaults,
    mascot: "none",
    brandIcon: "mark",
    workingIndicator: "dots",
    workingPhrases: ["Building"],
    critters: ["penguin", "fedora"],
    avatarHat: "fedora",
  });
});

it("keeps explicit branding independent from mascot defaults", () => {
  const source = {
    mascot: "none",
    brandName: "Mission Control",
    brandIcon: "rocket",
    workingIndicator: "brand",
    lobsterdex: false,
    communityLinks: false,
    artwork: { icons: { rocket: { url: "/icon" } } },
  } as const;
  expect(resolveThemeBranding(source)).toMatchObject(source);
  expect(resolveThemeBranding({ mascot: "claw", workingIndicator: "none" }).workingIndicator).toBe(
    "none",
  );
});

it.each([
  ["dark", "dark"],
  [null, undefined],
])("normalizes only exact theme mode literals: %j", (input, expected) => {
  expect(normalizeThemeMode(input)).toBe(expected);
});

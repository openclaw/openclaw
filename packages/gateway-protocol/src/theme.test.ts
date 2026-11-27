import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
  createThemeDefinitionFixture as themeFixture,
  createThemePaletteFixture as paletteFixture,
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
  return themeFixture({ dark: paletteFixture(palette) });
}

function normalizeTheme(fields: Record<string, unknown>) {
  return normalizeThemeDefinition({ ...themeFixture(), ...fields });
}
const rejectTheme = (fields: Record<string, unknown>, message: string) =>
  expect(() => normalizeTheme(fields)).toThrow(message);

function acceptsImport(definition: unknown) {
  return Value.Check(ThemesImportParamsSchema, { id: "hat-theme", definition });
}

describe("portable theme definition", () => {
  it("accepts authored mascot, critters and hat, and normalizes custom working phrases", () => {
    const fields = { mascot: "none", critters: ["fedora", "penguin"], avatarHat: "fedora" };
    expect(
      normalizeTheme({ ...fields, workingPhrases: [" Building ", "x".repeat(24)] }),
    ).toMatchObject({ ...fields, workingPhrases: ["Building", "x".repeat(24)] });
  });

  it("accepts independent branding with no working indicator", () => {
    const fields = {
      brandName: "Mission Control",
      brandIcon: "mark",
      workingIndicator: "none",
      lobsterdex: false,
      communityLinks: false,
    } as const;
    expect(normalizeTheme({ ...fields, brandName: " Mission Control " })).toMatchObject(fields);
    expect(acceptsImport(themeFixture(fields))).toBe(true);
    expect(normalizeTheme({ ...fields, brandName: "a".repeat(80) }).brandName).toHaveLength(80);
  });

  it("restricts custom brand icons to the manifest's icon IDs", () => {
    const definition = themeFixture({ brandIcon: "rocket" });
    expect(() => normalizeThemeDefinition(definition)).toThrow("theme.brandIcon");
    expect(() =>
      normalizeThemeDefinition(definition, { hatIds: ["rocket"], critterIds: ["rocket"] }),
    ).toThrow("theme.brandIcon");
    expect(normalizeThemeDefinition(definition, { iconIds: ["rocket"] }).brandIcon).toBe("rocket");
    expect(parseThemeDefinition(definition)).toBeNull();
  });

  it("keeps null avatar hats out of personal definitions", () => {
    rejectTheme(
      { avatarHat: null },
      "theme.avatarHat must be one of fedora, crown, santa, party, pumpkin",
    );
    expect(acceptsImport({ ...themeFixture(), avatarHat: null })).toBe(false);
  });

  it("accepts plugin artwork only from declared IDs of the corresponding kind", () => {
    const definition = themeFixture({ avatarHat: "beret", critters: ["ferris"] });
    expect(() => normalizeThemeDefinition(definition)).toThrow(
      "theme.critters[0] must be one of penguin, fedora",
    );
    expect(() =>
      normalizeThemeDefinition(definition, { hatIds: ["ferris"], critterIds: ["beret"] }),
    ).toThrow("theme.critters[0]");
    expect(
      normalizeThemeDefinition(definition, { hatIds: ["beret"], critterIds: ["ferris"] }),
    ).toMatchObject({ avatarHat: "beret", critters: ["ferris"] });
    expect(acceptsImport(definition)).toBe(true);
    expect(parseThemeDefinition(definition)).toBeNull();
  });

  it("rejects nonportable artwork IDs at the wire boundary", () => {
    const id = "<svg>";
    for (const branding of [{ brandIcon: id }, { avatarHat: id }, { critters: [id] }]) {
      expect(acceptsImport(themeFixture(branding))).toBe(false);
    }
  });

  it.each<[Record<string, unknown>, string]>([
    [{ brandName: "hello\ud800" }, "theme.brandName"],
    [{ workingIndicator: "spinner" }, "theme.workingIndicator"],
    [{ lobsterdex: "false" }, "theme.lobsterdex"],
    [{ mascot: "robot" }, "theme.mascot must be one of claw, none"],
    [
      { workingPhrases: Array.from({ length: 25 }, (_, i) => `Working ${i}`) },
      "at most 24 entries",
    ],
    [{ workingPhrases: ["Building", " Building "] }, "duplicate entries after trimming"],
    [{ critters: Array.from({ length: 9 }, () => "penguin") }, "at most 8 entries"],
    [{ critters: ["penguin", "penguin"] }, "duplicate entries"],
  ])("rejects invalid branding %j", (fields, message) => {
    rejectTheme(fields, message);
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

  it("preserves font family names", () => {
    const font = "JetBrains Mono, monospace";
    expect(
      normalizeThemeDefinition(createDarkTheme({ "font-sans": font })).dark?.["font-sans"],
    ).toBe(font);
  });

  it("rejects missing modes, incomplete palettes, unknown properties, and oversized stored values", () => {
    const { background: _background, ...incomplete } = paletteFixture();
    expect(() => normalizeThemeDefinition({ name: "Empty", description: "No colors" })).toThrow(
      "at least one",
    );
    rejectTheme({ dark: incomplete }, "background");
    rejectTheme({ css: "body {}" }, "unsupported field");
    const longColor = `rgb(0.${"1".repeat(85)} 0 0)`;
    const palette = paletteFixture(
      Object.fromEntries(THEME_COLOR_KEYS.map((key) => [key, longColor])),
    );
    rejectTheme({ light: palette, dark: palette }, "4096 bytes");
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
  expect(resolveThemeBranding({ workingPhrases: [] })).toEqual({ ...defaults, workingPhrases: [] });
  const authored = {
    mascot: "none",
    workingPhrases: ["Building"],
    critters: ["penguin", "fedora"],
    avatarHat: "fedora",
  } as const;
  expect(resolveThemeBranding(authored)).toEqual({
    ...defaults,
    ...authored,
    brandIcon: "mark",
    workingIndicator: "dots",
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

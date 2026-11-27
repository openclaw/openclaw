import type { Static } from "typebox";
import type { SchemaContract } from "./schema-contract.js";
import type { ThemeDefinitionSchema } from "./schema/themes.js";
import type { ThemeId } from "./theme-ids.ts";
export {
  BUILTIN_THEME_IDS,
  THEME_LOCAL_ID_MAX_LENGTH,
  THEME_LOCAL_ID_PATTERN,
  isBuiltinThemeId,
  isThemeId,
  normalizeThemeMode,
  type BuiltinThemeId,
  type ThemeId,
  type ThemeMode,
} from "./theme-ids.ts";

/** Portable theme data shared by profile preferences, plugins, and the Control UI. */
export type ThemeColorMode = "light" | "dark";

export const THEME_COLOR_KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
] as const;
export const THEME_FONT_KEYS = ["font-sans", "font-mono"] as const;
export const THEME_MASCOT_VALUES = ["claw", "none"] as const;
export type ThemeMascot = (typeof THEME_MASCOT_VALUES)[number];
export const THEME_BRAND_ICON_IDS = ["claw", "mark"] as const;
export const THEME_WORKING_INDICATOR_VALUES = ["claw", "dots", "brand", "none"] as const;
export type ThemeWorkingIndicator = (typeof THEME_WORKING_INDICATOR_VALUES)[number];
export const THEME_BRAND_NAME_MAX_LENGTH = 80;
export const THEME_CRITTER_IDS = ["penguin", "fedora"] as const;
export type ThemeCritterId = (typeof THEME_CRITTER_IDS)[number];
export function isThemeCritterId(value: unknown): value is ThemeCritterId {
  return THEME_CRITTER_IDS.some((id) => id === value);
}
export const THEME_AVATAR_HAT_IDS = ["fedora", "crown", "santa", "party", "pumpkin"] as const;
export type ThemeAvatarHatId = (typeof THEME_AVATAR_HAT_IDS)[number];
export function isThemeAvatarHatId(value: unknown): value is ThemeAvatarHatId {
  return THEME_AVATAR_HAT_IDS.some((id) => id === value);
}
export const THEME_ARTWORK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
export const THEME_WORKING_PHRASES_MAX = 24;
export const THEME_WORKING_PHRASE_MAX_LENGTH = 24;
export const MAX_THEME_DEFINITION_BYTES = 4096;
export const THEME_NAME_MAX_LENGTH = 80;
export const THEME_DESCRIPTION_MAX_LENGTH = 320;
export const THEME_TOKEN_MAX_LENGTH = 120;

export type ThemePalette = Record<(typeof THEME_COLOR_KEYS)[number], string> &
  Partial<Record<(typeof THEME_FONT_KEYS)[number], string>>;
export type ThemeDefinition = SchemaContract<Static<typeof ThemeDefinitionSchema>>;
export type ThemeArtwork = {
  icons?: Record<string, { url: string }>;
  hats?: Record<string, { url: string }>;
  critters?: Record<string, { url: string; title?: string; crossMs?: number }>;
  /** Plugin-only canvas artwork per color mode; a missing mode keeps neutral artwork. */
  backgrounds?: Partial<Record<ThemeColorMode, { url: string }>>;
};
export type ThemeDescriptor = {
  id: ThemeId;
  name: string;
  description: string;
  source: "builtin" | "plugin" | "user";
  modes: ThemeColorMode[];
  pluginId?: string;
  mascot?: ThemeMascot;
  brandName?: string;
  brandIcon?: string;
  workingIndicator?: ThemeWorkingIndicator;
  lobsterdex?: boolean;
  communityLinks?: boolean;
  workingPhrases?: readonly string[];
  critters?: readonly string[];
  avatarHat?: string;
  artwork?: ThemeArtwork;
};
export type ThemeCatalogEntry = ThemeDescriptor & { definition?: ThemeDefinition };
export type ThemeBranding = {
  mascot: ThemeMascot;
  brandName: string;
  brandIcon: string;
  workingIndicator: ThemeWorkingIndicator;
  lobsterdex: boolean;
  communityLinks: boolean;
  workingPhrases?: readonly string[];
  critters: readonly string[];
  avatarHat?: string;
  artwork?: ThemeArtwork;
};

export { resolveThemeBranding } from "./theme-builtin-branding.js";
export { BUILTIN_THEMES } from "./theme-builtins.js";

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  // SAFETY: the non-null, non-array object is inspected only through its own keys below.
  return value as Record<string, unknown>;
}

function requireKeys(value: Record<string, unknown>, allowed: readonly string[], label: string) {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new Error(`${label} has unsupported field ${unknown}`);
  }
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > maxLength ||
    Array.from(value).some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
  ) {
    throw new Error(`${label} must be nonempty text of at most ${maxLength} characters`);
  }
  return value.trim();
}

function requireChoice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const choice = allowed.find((candidate) => candidate === value);
  if (!choice) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}`);
  }
  return choice;
}

const NUMBER = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?";
const COMPONENT = `${NUMBER}%?`;
const HUE = `${NUMBER}(?:deg|grad|rad|turn)?`;
const LEGACY_COLOR_FUNCTION = /* @__PURE__ */ new RegExp(
  `^(?:(?:rgb|rgba)\\( *(?:${NUMBER} *, *${NUMBER} *, *${NUMBER}|${NUMBER}% *, *${NUMBER}% *, *${NUMBER}%)|(?:hsl|hsla)\\( *${HUE} *, *${NUMBER}% *, *${NUMBER}%)(?: *, *${COMPONENT})? *\\)$`,
  "i",
);
const COLOR_FUNCTION = /* @__PURE__ */ new RegExp(
  `^(?:(?:rgb|rgba|oklab|lab)\\( *${COMPONENT} +${COMPONENT} +${COMPONENT}|(?:hsl|hsla)\\( *${HUE} +${COMPONENT} +${COMPONENT}|(?:oklch|lch)\\( *${COMPONENT} +${COMPONENT} +${HUE})(?: */ *${COMPONENT})? *\\)$`,
  "i",
);
const COLOR_SPACE_FUNCTION = /* @__PURE__ */ new RegExp(
  `^color\\( *(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65) +${COMPONENT} +${COMPONENT} +${COMPONENT}(?: */ *${COMPONENT})? *\\)$`,
  "i",
);
const FONT_IDENTIFIER = "(?:--[a-z0-9_-]*|-?[a-z_][a-z0-9_-]*)";
const FONT_FAMILY = `(?:"[a-z0-9 ,'._-]*"|'[a-z0-9 ,"._-]*'|${FONT_IDENTIFIER}(?: +${FONT_IDENTIFIER})*)`;
const FONT_FAMILY_LIST = /* @__PURE__ */ new RegExp(
  `^${FONT_FAMILY}(?: *, *${FONT_FAMILY})*$`,
  "i",
);
const CSS_WIDE_KEYWORDS = new Set(["inherit", "initial", "unset", "revert", "revert-layer"]);
const GENERIC_FONT_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "emoji",
  "math",
  "fangsong",
  "-webkit-body",
]);

function isFontFamilyList(value: string): boolean {
  if (!FONT_FAMILY_LIST.test(value)) {
    return false;
  }
  // Quoted names may contain commas or match reserved keywords.
  return value
    .replace(/"[^"]*"|'[^']*'/g, "")
    .split(",")
    .every((family) => {
      const normalized = family.trim().toLowerCase();
      const words = normalized.split(/ +/);
      return words.every(
        (word) =>
          !CSS_WIDE_KEYWORDS.has(word) &&
          word !== "default" &&
          (words.length === 1 || !GENERIC_FONT_FAMILIES.has(word)),
      );
    });
}

function requireColor(value: unknown, label: string): string {
  const color = requireText(value, label, THEME_TOKEN_MAX_LENGTH);
  if (
    !/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) &&
    !/^(?:transparent|black|white)$/i.test(color) &&
    !LEGACY_COLOR_FUNCTION.test(color) &&
    !COLOR_FUNCTION.test(color) &&
    !COLOR_SPACE_FUNCTION.test(color)
  ) {
    throw new Error(`${label} must be a hex, rgb, hsl, lab, lch, oklab, oklch, or color() color`);
  }
  return color;
}

function normalizePalette(value: unknown, mode: ThemeColorMode): ThemePalette {
  const palette = requireRecord(value, `theme.${mode}`);
  requireKeys(palette, [...THEME_COLOR_KEYS, ...THEME_FONT_KEYS], `theme.${mode}`);
  const entries = THEME_COLOR_KEYS.map((key) => [
    key,
    requireColor(palette[key], `theme.${mode}.${key}`),
  ]);
  // SAFETY: every required color key is emitted exactly once, after validating its value.
  const result = Object.fromEntries(entries) as ThemePalette;
  for (const key of THEME_FONT_KEYS) {
    if (palette[key] === undefined) {
      continue;
    }
    const font = requireText(palette[key], `theme.${mode}.${key}`, THEME_TOKEN_MAX_LENGTH);
    if (!isFontFamilyList(font)) {
      throw new Error(`theme.${mode}.${key} must contain only font family names`);
    }
    result[key] = font;
  }
  return result;
}

/** Rejects executable CSS and incomplete palettes before they reach storage or a stylesheet. */
export function normalizeThemeDefinition(
  input: unknown,
  options?: {
    iconIds?: readonly string[];
    hatIds?: readonly string[];
    critterIds?: readonly string[];
  },
): ThemeDefinition {
  const record = requireRecord(input, "theme");
  requireKeys(
    record,
    [
      "name",
      "description",
      "mascot",
      "brandName",
      "brandIcon",
      "workingIndicator",
      "lobsterdex",
      "communityLinks",
      "workingPhrases",
      "critters",
      "avatarHat",
      "light",
      "dark",
    ],
    "theme",
  );
  const definition: ThemeDefinition = {
    name: requireText(record.name, "theme.name", THEME_NAME_MAX_LENGTH),
    description: requireText(record.description, "theme.description", THEME_DESCRIPTION_MAX_LENGTH),
    ...(record.light !== undefined ? { light: normalizePalette(record.light, "light") } : {}),
    ...(record.dark !== undefined ? { dark: normalizePalette(record.dark, "dark") } : {}),
  };
  if (record.mascot !== undefined) {
    definition.mascot = requireChoice(record.mascot, THEME_MASCOT_VALUES, "theme.mascot");
  }
  if (record.brandName !== undefined) {
    const brandName = requireText(record.brandName, "theme.brandName", THEME_BRAND_NAME_MAX_LENGTH);
    if (/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(brandName)) {
      throw new Error("theme.brandName must contain only printable characters");
    }
    definition.brandName = brandName;
  }
  if (record.brandIcon !== undefined) {
    definition.brandIcon = requireChoice(
      record.brandIcon,
      [...THEME_BRAND_ICON_IDS, ...(options?.iconIds ?? [])],
      "theme.brandIcon",
    );
  }
  if (record.workingIndicator !== undefined) {
    definition.workingIndicator = requireChoice(
      record.workingIndicator,
      THEME_WORKING_INDICATOR_VALUES,
      "theme.workingIndicator",
    );
  }
  for (const key of ["lobsterdex", "communityLinks"] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== "boolean") {
        throw new Error(`theme.${key} must be a boolean`);
      }
      definition[key] = record[key];
    }
  }
  if (record.workingPhrases !== undefined) {
    if (
      !Array.isArray(record.workingPhrases) ||
      record.workingPhrases.length > THEME_WORKING_PHRASES_MAX
    ) {
      throw new Error(
        `theme.workingPhrases must be an array of at most ${THEME_WORKING_PHRASES_MAX} entries`,
      );
    }
    const phrases = Array.from(record.workingPhrases, (phrase, index) =>
      requireText(phrase, `theme.workingPhrases[${index}]`, THEME_WORKING_PHRASE_MAX_LENGTH),
    );
    if (new Set(phrases).size !== phrases.length) {
      throw new Error("theme.workingPhrases must not contain duplicate entries after trimming");
    }
    definition.workingPhrases = phrases;
  }
  if (record.critters !== undefined) {
    if (!Array.isArray(record.critters) || record.critters.length > 8) {
      throw new Error("theme.critters must be an array of at most 8 entries");
    }
    const allowedIds = [...THEME_CRITTER_IDS, ...(options?.critterIds ?? [])];
    const critters = Array.from(record.critters, (entry, index) =>
      requireChoice(entry, allowedIds, `theme.critters[${index}]`),
    );
    if (new Set(critters).size !== critters.length) {
      throw new Error("theme.critters must not contain duplicate entries");
    }
    definition.critters = critters;
  }
  if (record.avatarHat !== undefined) {
    definition.avatarHat = requireChoice(
      record.avatarHat,
      [...THEME_AVATAR_HAT_IDS, ...(options?.hatIds ?? [])],
      "theme.avatarHat",
    );
  }
  if (!definition.light && !definition.dark) {
    throw new Error("theme must provide at least one light or dark palette");
  }
  if (new TextEncoder().encode(JSON.stringify(definition)).length > MAX_THEME_DEFINITION_BYTES) {
    throw new Error(`theme definition exceeds ${MAX_THEME_DEFINITION_BYTES} bytes`);
  }
  return definition;
}

export function parseThemeDefinition(value: unknown): ThemeDefinition | null {
  try {
    return normalizeThemeDefinition(value);
  } catch {
    return null;
  }
}

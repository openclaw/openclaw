import type { ThemeId } from "./theme-ids.js";
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
} from "./theme-ids.js";

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
export const THEME_CRITTER_IDS = ["penguin", "fedora"] as const;
export type ThemeCritterId = (typeof THEME_CRITTER_IDS)[number];
export function isThemeCritterId(value: unknown): value is ThemeCritterId {
  return THEME_CRITTER_IDS.some((id) => id === value);
}
export const THEME_AVATAR_HAT_IDS = ["fedora", "crown", "santa", "party", "pumpkin"] as const;
export type ThemeAvatarHatId = (typeof THEME_AVATAR_HAT_IDS)[number];
export const THEME_WORKING_PHRASES_MAX = 24;
export const THEME_WORKING_PHRASE_MAX_LENGTH = 24;
export const MAX_THEME_DEFINITION_BYTES = 4096;
export const THEME_NAME_MAX_LENGTH = 80;
export const THEME_DESCRIPTION_MAX_LENGTH = 320;
export const THEME_TOKEN_MAX_LENGTH = 120;

export type ThemePalette = Record<(typeof THEME_COLOR_KEYS)[number], string> &
  Partial<Record<(typeof THEME_FONT_KEYS)[number], string>>;
export type ThemeDefinition = {
  name: string;
  description: string;
  mascot?: ThemeMascot;
  workingPhrases?: string[];
  critters?: ThemeCritterId[];
  avatarHat?: ThemeAvatarHatId;
  light?: ThemePalette;
  dark?: ThemePalette;
};
export type ThemeDescriptor = {
  id: ThemeId;
  name: string;
  description: string;
  source: "builtin" | "plugin" | "user";
  modes: ThemeColorMode[];
  pluginId?: string;
  mascot?: ThemeMascot;
  workingPhrases?: readonly string[];
  critters?: readonly ThemeCritterId[];
  avatarHat?: ThemeAvatarHatId;
};
export type ThemeCatalogEntry = ThemeDescriptor & { definition?: ThemeDefinition };
export type ThemeBranding = {
  mascot: ThemeMascot;
  workingPhrases?: readonly string[];
  critters: readonly ThemeCritterId[];
  avatarHat?: ThemeAvatarHatId;
};

const DEFAULT_THEME_CRITTERS: readonly ThemeCritterId[] = [];

export function resolveThemeBranding(
  source: Pick<ThemeDescriptor, "mascot" | "workingPhrases" | "critters" | "avatarHat"> | undefined,
): ThemeBranding {
  return {
    mascot: source?.mascot ?? "claw",
    workingPhrases: source?.workingPhrases,
    critters: source?.critters ?? DEFAULT_THEME_CRITTERS,
    avatarHat: source?.avatarHat,
  };
}

export const BUILTIN_THEMES: readonly ThemeDescriptor[] = (
  [
    {
      id: "claw",
      name: "Claw",
      description:
        "Signature coral red and teal on charcoal or pale surfaces, with Instrument Sans throughout. A balanced everyday workspace.",
    },
    {
      id: "knot",
      name: "Knot",
      description:
        "Crimson accents on true black or clean white, with Geist typography. Sharp, minimal, and high contrast.",
    },
    {
      id: "dash",
      name: "Dash",
      description:
        "Toasted caramel on deep cocoa or warm cream, with DM Sans controls and Fraunces serif chat. Warm and bookish.",
    },
    {
      id: "absolutely",
      name: "Absolutely",
      description:
        "Terracotta clay on warm graphite or soft cream, with Space Grotesk controls and Lora serif chat. Quiet editorial character.",
    },
    {
      id: "tide",
      name: "Tide",
      description:
        "Steel cyan on cool slate or pale blue-gray, with IBM Plex Sans throughout. Calm, technical, and understated.",
    },
    {
      id: "beacon",
      name: "Beacon",
      description:
        "High-visibility amber on black or white, bold focus rings, and Atkinson Hyperlegible typography. Designed for maximum readability.",
    },
    {
      id: "phosphor",
      name: "Phosphor",
      description:
        "Luminous green on green-tinted black or pale green, with JetBrains Mono throughout. A classic green terminal atmosphere.",
    },
    {
      id: "crt",
      name: "CRT",
      description:
        "White phosphor and amber on tube black, with a light counterpart, JetBrains Mono, and nearly square corners. A retro computer console.",
    },
    {
      id: "manuscript",
      name: "Manuscript",
      description:
        "Lapis blue and gold on aged paper, with a dark reading-room variant and Lora serif throughout. A quiet illuminated manuscript.",
    },
    {
      id: "rose",
      name: "Rosé",
      description:
        "Dried rose and gold on deep plum-gray or soft rose-tinted cream, with DM Sans. Gentle, muted, and warm.",
    },
    {
      id: "miami",
      name: "Miami",
      description:
        "Hot magenta and cyan on violet-black or pale lavender, with Space Grotesk. Bright neon energy and a synthwave character.",
    },
  ] satisfies Array<Pick<ThemeDescriptor, "id" | "name" | "description">>
).map<ThemeDescriptor>((theme) => ({
  id: theme.id,
  name: theme.name,
  description: theme.description,
  source: "builtin",
  modes: ["light", "dark"],
}));

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

const NUMBER = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:e[+-]?\\d+)?";
const COMPONENT = `${NUMBER}%?`;
const HUE = `${NUMBER}(?:deg|grad|rad|turn)?`;
const LEGACY_COLOR_FUNCTION = new RegExp(
  `^(?:(?:rgb|rgba)\\( *(?:${NUMBER} *, *${NUMBER} *, *${NUMBER}|${NUMBER}% *, *${NUMBER}% *, *${NUMBER}%)|(?:hsl|hsla)\\( *${HUE} *, *${NUMBER}% *, *${NUMBER}%)(?: *, *${COMPONENT})? *\\)$`,
  "i",
);
const COLOR_FUNCTION = new RegExp(
  `^(?:(?:rgb|rgba|oklab|lab)\\( *${COMPONENT} +${COMPONENT} +${COMPONENT}|(?:hsl|hsla)\\( *${HUE} +${COMPONENT} +${COMPONENT}|(?:oklch|lch)\\( *${COMPONENT} +${COMPONENT} +${HUE})(?: */ *${COMPONENT})? *\\)$`,
  "i",
);
const COLOR_SPACE_FUNCTION = new RegExp(
  `^color\\( *(?:srgb|srgb-linear|display-p3|a98-rgb|prophoto-rgb|rec2020|xyz|xyz-d50|xyz-d65) +${COMPONENT} +${COMPONENT} +${COMPONENT}(?: */ *${COMPONENT})? *\\)$`,
  "i",
);
const FONT_IDENTIFIER = "(?:--[a-z0-9_-]*|-?[a-z_][a-z0-9_-]*)";
const FONT_FAMILY = `(?:"[a-z0-9 ,'._-]*"|'[a-z0-9 ,"._-]*'|${FONT_IDENTIFIER}(?: +${FONT_IDENTIFIER})*)`;
const FONT_FAMILY_LIST = new RegExp(`^${FONT_FAMILY}(?: *, *${FONT_FAMILY})*$`, "i");
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
  const colors = Object.fromEntries(entries) as Record<(typeof THEME_COLOR_KEYS)[number], string>;
  const result: ThemePalette = { ...colors };
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
export function normalizeThemeDefinition(value: unknown): ThemeDefinition {
  const record = requireRecord(value, "theme");
  requireKeys(
    record,
    ["name", "description", "mascot", "workingPhrases", "critters", "avatarHat", "light", "dark"],
    "theme",
  );
  const definition: ThemeDefinition = {
    name: requireText(record.name, "theme.name", THEME_NAME_MAX_LENGTH),
    description: requireText(record.description, "theme.description", THEME_DESCRIPTION_MAX_LENGTH),
    ...(record.light !== undefined ? { light: normalizePalette(record.light, "light") } : {}),
    ...(record.dark !== undefined ? { dark: normalizePalette(record.dark, "dark") } : {}),
  };
  if (record.mascot !== undefined) {
    const mascot = THEME_MASCOT_VALUES.find((candidate) => candidate === record.mascot);
    if (!mascot) {
      throw new Error(`theme.mascot must be one of ${THEME_MASCOT_VALUES.join(", ")}`);
    }
    definition.mascot = mascot;
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
    const critters = Array.from(record.critters, (entry, index) => {
      const critter = THEME_CRITTER_IDS.find((id) => id === entry);
      if (!critter) {
        throw new Error(`theme.critters[${index}] must be one of ${THEME_CRITTER_IDS.join(", ")}`);
      }
      return critter;
    });
    if (new Set(critters).size !== critters.length) {
      throw new Error("theme.critters must not contain duplicate entries");
    }
    definition.critters = critters;
  }
  if (record.avatarHat !== undefined) {
    const avatarHat = THEME_AVATAR_HAT_IDS.find((id) => id === record.avatarHat);
    if (!avatarHat) {
      throw new Error(`theme.avatarHat must be one of ${THEME_AVATAR_HAT_IDS.join(", ")}`);
    }
    definition.avatarHat = avatarHat;
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

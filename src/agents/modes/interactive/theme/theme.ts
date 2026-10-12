import * as fs from "node:fs";
import { getCapabilities } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import type { SourceInfo } from "../../../sessions/source-info.js";
import { highlight, supportsLanguage } from "../../../utils/syntax-highlight.js";

const ColorValueSchema = Type.Union([
  Type.String(), // hex "#ff0000", var ref "primary", or empty ""
  Type.Integer({ minimum: 0, maximum: 255 }), // 256-color index
]);

type ColorValue = Static<typeof ColorValueSchema>;

const ThemeJsonSchema = Type.Object({
  $schema: Type.Optional(Type.String()),
  name: Type.String(),
  vars: Type.Optional(Type.Record(Type.String(), ColorValueSchema)),
  colors: Type.Object({
    accent: ColorValueSchema,
    border: ColorValueSchema,
    borderAccent: ColorValueSchema,
    borderMuted: ColorValueSchema,
    success: ColorValueSchema,
    error: ColorValueSchema,
    warning: ColorValueSchema,
    muted: ColorValueSchema,
    dim: ColorValueSchema,
    text: ColorValueSchema,
    thinkingText: ColorValueSchema,
    selectedBg: ColorValueSchema,
    userMessageBg: ColorValueSchema,
    userMessageText: ColorValueSchema,
    customMessageBg: ColorValueSchema,
    customMessageText: ColorValueSchema,
    customMessageLabel: ColorValueSchema,
    toolPendingBg: ColorValueSchema,
    toolSuccessBg: ColorValueSchema,
    toolErrorBg: ColorValueSchema,
    toolTitle: ColorValueSchema,
    toolOutput: ColorValueSchema,
    mdHeading: ColorValueSchema,
    mdLink: ColorValueSchema,
    mdLinkUrl: ColorValueSchema,
    mdCode: ColorValueSchema,
    mdCodeBlock: ColorValueSchema,
    mdCodeBlockBorder: ColorValueSchema,
    mdQuote: ColorValueSchema,
    mdQuoteBorder: ColorValueSchema,
    mdHr: ColorValueSchema,
    mdListBullet: ColorValueSchema,
    toolDiffAdded: ColorValueSchema,
    toolDiffRemoved: ColorValueSchema,
    toolDiffContext: ColorValueSchema,
    syntaxComment: ColorValueSchema,
    syntaxKeyword: ColorValueSchema,
    syntaxFunction: ColorValueSchema,
    syntaxVariable: ColorValueSchema,
    syntaxString: ColorValueSchema,
    syntaxNumber: ColorValueSchema,
    syntaxType: ColorValueSchema,
    syntaxOperator: ColorValueSchema,
    syntaxPunctuation: ColorValueSchema,
    thinkingOff: ColorValueSchema,
    thinkingMinimal: ColorValueSchema,
    thinkingLow: ColorValueSchema,
    thinkingMedium: ColorValueSchema,
    thinkingHigh: ColorValueSchema,
    thinkingXhigh: ColorValueSchema,
    bashMode: ColorValueSchema,
  }),
  export: Type.Optional(
    Type.Object({
      pageBg: Type.Optional(ColorValueSchema),
      cardBg: Type.Optional(ColorValueSchema),
      infoBg: Type.Optional(ColorValueSchema),
    }),
  ),
});

type ThemeJson = Static<typeof ThemeJsonSchema>;

const validateThemeJson = Compile(ThemeJsonSchema);

type ThemeColor = Exclude<keyof ThemeJson["colors"], ThemeBg>;

const BACKGROUND_COLOR_KEYS = [
  "selectedBg",
  "userMessageBg",
  "customMessageBg",
  "toolPendingBg",
  "toolSuccessBg",
  "toolErrorBg",
] as const;
type ThemeBg = (typeof BACKGROUND_COLOR_KEYS)[number];

type ColorMode = "truecolor" | "256color";

const THINKING_BORDER_COLORS = new Map<string, ThemeColor>([
  ["minimal", "thinkingMinimal"],
  ["low", "thinkingLow"],
  ["medium", "thinkingMedium"],
  ["high", "thinkingHigh"],
  ["xhigh", "thinkingXhigh"],
]);

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const cleaned = hex.replace("#", "");
  if (cleaned.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = Number.parseInt(cleaned.slice(0, 2), 16);
  const g = Number.parseInt(cleaned.slice(2, 4), 16);
  const b = Number.parseInt(cleaned.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return { r, g, b };
}

// The 6x6x6 color cube channel values (indices 0-5)
const CUBE_VALUES = [0, 95, 135, 175, 215, 255];

// Grayscale ramp values (indices 232-255, 24 grays from 8 to 238)
const GRAY_VALUES = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function findClosestPaletteIndex(value: number, palette: readonly number[]): number {
  let minDist = Infinity;
  let minIdx = 0;
  for (const [i, paletteValue] of palette.entries()) {
    const dist = Math.abs(value - paletteValue);
    if (dist < minDist) {
      minDist = dist;
      minIdx = i;
    }
  }
  return minIdx;
}

function colorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  // Weighted Euclidean distance (human eye is more sensitive to green)
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return dr * dr * 0.299 + dg * dg * 0.587 + db * db * 0.114;
}

function rgbTo256(r: number, g: number, b: number): number {
  const rIdx = findClosestPaletteIndex(r, CUBE_VALUES);
  const gIdx = findClosestPaletteIndex(g, CUBE_VALUES);
  const bIdx = findClosestPaletteIndex(b, CUBE_VALUES);
  const cubeR = CUBE_VALUES[rIdx];
  const cubeG = CUBE_VALUES[gIdx];
  const cubeB = CUBE_VALUES[bIdx];
  if (cubeR === undefined || cubeG === undefined || cubeB === undefined) {
    throw new Error("Invalid 256-color cube index");
  }
  const cubeIndex = 16 + 36 * rIdx + 6 * gIdx + bIdx;
  const cubeDist = colorDistance(r, g, b, cubeR, cubeG, cubeB);

  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  const grayIdx = findClosestPaletteIndex(gray, GRAY_VALUES);
  const grayValue = GRAY_VALUES[grayIdx];
  if (grayValue === undefined) {
    throw new Error("Invalid 256-color grayscale index");
  }
  const grayIndex = 232 + grayIdx;
  const grayDist = colorDistance(r, g, b, grayValue, grayValue, grayValue);

  // Check if color has noticeable saturation (hue matters)
  // If max-min spread is significant, prefer cube to preserve tint
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const spread = maxC - minC;

  if (spread < 10 && grayDist < cubeDist) {
    return grayIndex;
  }

  return cubeIndex;
}

function colorAnsi(color: string | number, mode: ColorMode, layer: "fg" | "bg"): string {
  const code = layer === "fg" ? 38 : 48;
  if (color === "") {
    return layer === "fg" ? "\x1b[39m" : "\x1b[49m";
  }
  if (typeof color === "number") {
    return `\x1b[${code};5;${color}m`;
  }
  if (color.startsWith("#")) {
    const { r, g, b } = hexToRgb(color);
    return mode === "truecolor"
      ? `\x1b[${code};2;${r};${g};${b}m`
      : `\x1b[${code};5;${rgbTo256(r, g, b)}m`;
  }
  throw new Error(`Invalid color value: ${color}`);
}

function resolveVarRefs(
  value: ColorValue,
  vars: Record<string, ColorValue>,
  visited = new Set<string>(),
): string | number {
  if (typeof value === "number" || value === "" || value.startsWith("#")) {
    return value;
  }
  if (visited.has(value)) {
    throw new Error(`Circular variable reference detected: ${value}`);
  }
  visited.add(value);
  const resolved = vars[value];
  if (resolved === undefined) {
    throw new Error(`Variable reference not found: ${value}`);
  }
  return resolveVarRefs(resolved, vars, visited);
}

function resolveThemeColors<T extends Record<string, ColorValue>>(
  colors: T,
  vars: Record<string, ColorValue> = {},
): Record<keyof T, string | number> {
  const resolved: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(colors)) {
    resolved[key] = resolveVarRefs(value, vars);
  }
  return resolved as Record<keyof T, string | number>;
}

// Keep formatting independent of overridable public ANSI getters.
function getThemeAnsi(colors: ReadonlyMap<string, string>, color: string, label: string): string {
  const ansi = colors.get(color);
  if (!ansi) {
    throw new Error(`Unknown theme ${label}: ${color}`);
  }
  return ansi;
}

export class Theme {
  readonly name?: string;
  readonly sourcePath?: string;
  sourceInfo?: SourceInfo;
  private fgColors: Map<ThemeColor, string>;
  private bgColors: Map<ThemeBg, string>;
  private mode: ColorMode;

  constructor(
    fgColors: Record<ThemeColor, string | number>,
    bgColors: Record<ThemeBg, string | number>,
    mode: ColorMode,
    options: { name?: string; sourcePath?: string; sourceInfo?: SourceInfo } = {},
  ) {
    this.name = options.name;
    this.sourcePath = options.sourcePath;
    this.sourceInfo = options.sourceInfo;
    this.mode = mode;
    this.fgColors = new Map();
    for (const [key, value] of Object.entries(fgColors) as [ThemeColor, string | number][]) {
      this.fgColors.set(key, colorAnsi(value, mode, "fg"));
    }
    this.bgColors = new Map();
    for (const [key, value] of Object.entries(bgColors) as [ThemeBg, string | number][]) {
      this.bgColors.set(key, colorAnsi(value, mode, "bg"));
    }
  }

  fg(color: ThemeColor, text: string): string {
    const ansi = getThemeAnsi(this.fgColors, color, "color");
    return `${ansi}${text}\x1b[39m`; // Reset only foreground color
  }

  bg(color: ThemeBg, text: string): string {
    const ansi = getThemeAnsi(this.bgColors, color, "background color");
    return `${ansi}${text}\x1b[49m`; // Reset only background color
  }

  bold(text: string): string {
    return chalk.bold(text);
  }

  italic(text: string): string {
    return chalk.italic(text);
  }

  underline(text: string): string {
    return chalk.underline(text);
  }

  inverse(text: string): string {
    return chalk.inverse(text);
  }

  strikethrough(text: string): string {
    return chalk.strikethrough(text);
  }

  getFgAnsi(color: ThemeColor): string {
    return getThemeAnsi(this.fgColors, color, "color");
  }

  getBgAnsi(color: ThemeBg): string {
    return getThemeAnsi(this.bgColors, color, "background color");
  }

  getColorMode(): ColorMode {
    return this.mode;
  }

  getThinkingBorderColor(
    level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh",
  ): (str: string) => string {
    const color = THINKING_BORDER_COLORS.get(level) ?? "thinkingOff";
    return (str: string) => this.fg(color, str);
  }

  getBashModeBorderColor(): (str: string) => string {
    return (str: string) => this.fg("bashMode", str);
  }
}

function parseThemeJson(label: string, json: unknown): ThemeJson {
  if (!validateThemeJson.Check(json)) {
    const errors = Array.from(validateThemeJson.Errors(json));
    const missingColors = new Set<string>();
    const otherErrors: string[] = [];

    for (const error of errors) {
      if (error.keyword === "required" && error.instancePath === "/colors") {
        const requiredProperties = (error.params as { requiredProperties?: string[] })
          .requiredProperties;
        for (const requiredProperty of requiredProperties ?? []) {
          missingColors.add(requiredProperty);
        }
        continue;
      }

      const pathLocal = error.instancePath || "/";
      otherErrors.push(`  - ${pathLocal}: ${error.message}`);
    }

    let errorMessage = `Invalid theme "${label}":\n`;
    if (missingColors.size > 0) {
      errorMessage += "\nMissing required color tokens:\n";
      errorMessage += Array.from(missingColors)
        .toSorted()
        .map((color) => `  - ${color}`)
        .join("\n");
      errorMessage += '\n\nPlease add these colors to your theme\'s "colors" object.';
      errorMessage += "\nSee the built-in themes (dark.json, light.json) for reference values.";
    }
    if (otherErrors.length > 0) {
      errorMessage += `\n\nOther errors:\n${otherErrors.join("\n")}`;
    }

    throw new Error(errorMessage);
  }

  return json;
}

function parseThemeJsonContent(label: string, content: string): ThemeJson {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse theme ${label}: ${message}`, { cause: error });
  }
  return parseThemeJson(label, json);
}

function createTheme(themeJson: ThemeJson, mode?: ColorMode, sourcePath?: string): Theme {
  const colorMode = mode ?? (getCapabilities().trueColor ? "truecolor" : "256color");
  const resolvedColors = resolveThemeColors(themeJson.colors, themeJson.vars);
  const fgColors: Record<ThemeColor, string | number> = {} as Record<ThemeColor, string | number>;
  const bgColors: Record<ThemeBg, string | number> = {} as Record<ThemeBg, string | number>;
  const bgColorKeys: Set<string> = new Set(BACKGROUND_COLOR_KEYS);
  for (const [key, value] of Object.entries(resolvedColors)) {
    if (bgColorKeys.has(key)) {
      bgColors[key as ThemeBg] = value;
    } else {
      fgColors[key as ThemeColor] = value;
    }
  }
  return new Theme(fgColors, bgColors, colorMode, {
    name: themeJson.name,
    sourcePath,
  });
}

export function loadThemeFromPath(themePath: string, mode?: ColorMode): Theme {
  const content = fs.readFileSync(themePath, "utf-8");
  const themeJson = parseThemeJsonContent(themePath, content);
  return createTheme(themeJson, mode, themePath);
}

// Use globalThis to share theme across module loaders (tsx + jiti in dev mode)
const THEME_KEY = Symbol.for("openclaw:agent-theme");

export const interactiveAgentTheme: Theme = new Proxy({} as Theme, {
  get(_target, prop) {
    const t = (globalThis as Record<symbol, Theme>)[THEME_KEY];
    if (!t) {
      throw new Error("Theme not initialized. Call setTheme() first.");
    }
    return (t as unknown as Record<string | symbol, unknown>)[prop];
  },
});

// Resolve the shared proxy at render time so replacing the global theme stays live.
const cliHighlightTheme: Record<string, (s: string) => string> = {
  keyword: (s) => interactiveAgentTheme.fg("syntaxKeyword", s),
  built_in: (s) => interactiveAgentTheme.fg("syntaxType", s),
  literal: (s) => interactiveAgentTheme.fg("syntaxNumber", s),
  number: (s) => interactiveAgentTheme.fg("syntaxNumber", s),
  string: (s) => interactiveAgentTheme.fg("syntaxString", s),
  comment: (s) => interactiveAgentTheme.fg("syntaxComment", s),
  function: (s) => interactiveAgentTheme.fg("syntaxFunction", s),
  title: (s) => interactiveAgentTheme.fg("syntaxFunction", s),
  class: (s) => interactiveAgentTheme.fg("syntaxType", s),
  type: (s) => interactiveAgentTheme.fg("syntaxType", s),
  attr: (s) => interactiveAgentTheme.fg("syntaxVariable", s),
  variable: (s) => interactiveAgentTheme.fg("syntaxVariable", s),
  params: (s) => interactiveAgentTheme.fg("syntaxVariable", s),
  operator: (s) => interactiveAgentTheme.fg("syntaxOperator", s),
  punctuation: (s) => interactiveAgentTheme.fg("syntaxPunctuation", s),
};

export function highlightCode(code: string, lang?: string): string[] {
  // Validate language before highlighting to avoid stderr spam from cli-highlight
  const validLang = lang && supportsLanguage(lang) ? lang : undefined;
  // Skip highlighting when no valid language is specified. cli-highlight's
  // auto-detection is unreliable and can misidentify prose as AppleScript,
  // LiveCodeServer, etc., coloring random English words as keywords.
  if (!validLang) {
    return code.split("\n").map((line) => interactiveAgentTheme.fg("mdCodeBlock", line));
  }
  try {
    return highlight(code, validLang, cliHighlightTheme).split("\n");
  } catch {
    return code.split("\n");
  }
}

const EXTENSION_LANGUAGES: Record<string, string> = Object.fromEntries(
  Object.entries({
    typescript: ["ts", "tsx"],
    javascript: ["js", "jsx", "mjs", "cjs"],
    python: ["py"],
    ruby: ["rb"],
    rust: ["rs"],
    go: ["go"],
    java: ["java"],
    kotlin: ["kt"],
    swift: ["swift"],
    c: ["c", "h"],
    cpp: ["cpp", "cc", "cxx", "hpp"],
    csharp: ["cs"],
    php: ["php"],
    bash: ["sh", "bash", "zsh"],
    fish: ["fish"],
    powershell: ["ps1"],
    sql: ["sql"],
    html: ["html", "htm"],
    css: ["css"],
    scss: ["scss"],
    sass: ["sass"],
    less: ["less"],
    json: ["json"],
    yaml: ["yaml", "yml"],
    toml: ["toml"],
    xml: ["xml"],
    markdown: ["md", "markdown"],
    dockerfile: ["dockerfile"],
    makefile: ["makefile"],
    cmake: ["cmake"],
    lua: ["lua"],
    perl: ["perl"],
    r: ["r"],
    scala: ["scala"],
    clojure: ["clj"],
    elixir: ["ex", "exs"],
    erlang: ["erl"],
    haskell: ["hs"],
    ocaml: ["ml"],
    vim: ["vim"],
    graphql: ["graphql"],
    protobuf: ["proto"],
    hcl: ["tf", "hcl"],
  }).flatMap(([language, extensions]) =>
    extensions.map((extension) => [extension, language] as const),
  ),
);

export function getLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  return ext ? EXTENSION_LANGUAGES[ext] : undefined;
}

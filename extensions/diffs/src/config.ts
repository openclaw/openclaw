import type { OpenClawPluginConfigSchema } from "openclaw/plugin-sdk";
import {
  DIFF_INDICATORS,
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_THEMES,
  type DiffIndicators,
  type DiffLayout,
  type DiffMode,
  type DiffPresentationDefaults,
  type DiffTheme,
  type DiffToolDefaults,
} from "./types.js";

type DiffsPluginConfig = {
  defaults?: {
    fontFamily?: string;
    fontSize?: number;
    lineSpacing?: number;
    layout?: DiffLayout;
    showLineNumbers?: boolean;
    diffIndicators?: DiffIndicators;
    wordWrap?: boolean;
    background?: boolean;
    theme?: DiffTheme;
    mode?: DiffMode;
  };
};

export const DEFAULT_DIFFS_TOOL_DEFAULTS: DiffToolDefaults = {
  fontFamily: "Fira Code",
  fontSize: 15,
  lineSpacing: 1.6,
  layout: "unified",
  showLineNumbers: true,
  diffIndicators: "bars",
  wordWrap: true,
  background: true,
  theme: "dark",
  mode: "both",
};

const DIFFS_PLUGIN_CONFIG_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    defaults: {
      type: "object",
      additionalProperties: false,
      properties: {
        fontFamily: { type: "string", default: DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily },
        fontSize: {
          type: "number",
          minimum: 10,
          maximum: 24,
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize,
        },
        lineSpacing: {
          type: "number",
          minimum: 1,
          maximum: 3,
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing,
        },
        layout: {
          type: "string",
          enum: [...DIFF_LAYOUTS],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.layout,
        },
        showLineNumbers: {
          type: "boolean",
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.showLineNumbers,
        },
        diffIndicators: {
          type: "string",
          enum: [...DIFF_INDICATORS],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators,
        },
        wordWrap: { type: "boolean", default: DEFAULT_DIFFS_TOOL_DEFAULTS.wordWrap },
        background: { type: "boolean", default: DEFAULT_DIFFS_TOOL_DEFAULTS.background },
        theme: {
          type: "string",
          enum: [...DIFF_THEMES],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.theme,
        },
        mode: {
          type: "string",
          enum: [...DIFF_MODES],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.mode,
        },
      },
    },
  },
} as const;

export const diffsPluginConfigSchema: OpenClawPluginConfigSchema = {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    try {
      return { success: true, data: resolveDiffsPluginDefaults(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }],
        },
      };
    }
  },
  jsonSchema: DIFFS_PLUGIN_CONFIG_JSON_SCHEMA,
};

export function resolveDiffsPluginDefaults(config: unknown): DiffToolDefaults {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
  }

  const defaults = (config as DiffsPluginConfig).defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
  }

  return {
    fontFamily: normalizeFontFamily(defaults.fontFamily),
    fontSize: normalizeFontSize(defaults.fontSize),
    lineSpacing: normalizeLineSpacing(defaults.lineSpacing),
    layout: normalizeLayout(defaults.layout),
    showLineNumbers: defaults.showLineNumbers !== false,
    diffIndicators: normalizeDiffIndicators(defaults.diffIndicators),
    wordWrap: defaults.wordWrap !== false,
    background: defaults.background !== false,
    theme: normalizeTheme(defaults.theme),
    mode: normalizeMode(defaults.mode),
  };
}

export function toPresentationDefaults(defaults: DiffToolDefaults): DiffPresentationDefaults {
  const {
    fontFamily,
    fontSize,
    lineSpacing,
    layout,
    showLineNumbers,
    diffIndicators,
    wordWrap,
    background,
    theme,
  } = defaults;
  return {
    fontFamily,
    fontSize,
    lineSpacing,
    layout,
    showLineNumbers,
    diffIndicators,
    wordWrap,
    background,
    theme,
  };
}

function normalizeFontFamily(fontFamily?: string): string {
  const normalized = fontFamily?.trim();
  return normalized || DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily;
}

function normalizeFontSize(fontSize?: number): number {
  if (fontSize === undefined || !Number.isFinite(fontSize)) {
    return DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize;
  }
  const rounded = Math.floor(fontSize);
  return Math.min(Math.max(rounded, 10), 24);
}

function normalizeLineSpacing(lineSpacing?: number): number {
  if (lineSpacing === undefined || !Number.isFinite(lineSpacing)) {
    return DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing;
  }
  return Math.min(Math.max(lineSpacing, 1), 3);
}

function normalizeLayout(layout?: DiffLayout): DiffLayout {
  return layout && DIFF_LAYOUTS.includes(layout) ? layout : DEFAULT_DIFFS_TOOL_DEFAULTS.layout;
}

function normalizeDiffIndicators(diffIndicators?: DiffIndicators): DiffIndicators {
  return diffIndicators && DIFF_INDICATORS.includes(diffIndicators)
    ? diffIndicators
    : DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators;
}

function normalizeTheme(theme?: DiffTheme): DiffTheme {
  return theme && DIFF_THEMES.includes(theme) ? theme : DEFAULT_DIFFS_TOOL_DEFAULTS.theme;
}

function normalizeMode(mode?: DiffMode): DiffMode {
  return mode && DIFF_MODES.includes(mode) ? mode : DEFAULT_DIFFS_TOOL_DEFAULTS.mode;
}

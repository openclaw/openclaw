import { mapPluginConfigIssues } from "openclaw/plugin-sdk/extension-shared";
import {
  buildPluginConfigSchema,
  type OpenClawPluginConfigSchema,
} from "openclaw/plugin-sdk/plugin-entry";
import { asFiniteNumber, asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { clampInt, clampNumber } from "openclaw/plugin-sdk/text-utility-runtime";
import { z } from "zod";
import {
  DIFF_IMAGE_QUALITY_PRESETS,
  DIFF_INDICATORS,
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_OUTPUT_FORMATS,
  DIFF_THEMES,
  type DiffFileDefaults,
  type DiffImageQualityPreset,
  type DiffOutputFormat,
  type DiffToolDefaults,
} from "./types.js";
import { normalizeViewerBaseUrl } from "./url.js";

type DiffsPluginConfig = z.input<typeof DiffsPluginJsonSchemaSource>;

const DEFAULT_IMAGE_QUALITY_PROFILES = {
  standard: {
    scale: 2,
    maxWidth: 960,
    maxPixels: 8_000_000,
  },
  hq: {
    scale: 2.5,
    maxWidth: 1200,
    maxPixels: 14_000_000,
  },
  print: {
    scale: 3,
    maxWidth: 1400,
    maxPixels: 24_000_000,
  },
} as const satisfies Record<
  DiffImageQualityPreset,
  { scale: number; maxWidth: number; maxPixels: number }
>;

const DEFAULT_DIFFS_TOOL_DEFAULTS: DiffToolDefaults = {
  fontFamily: "Fira Code",
  fontSize: 15,
  lineSpacing: 1.6,
  layout: "unified",
  showLineNumbers: true,
  diffIndicators: "bars",
  wordWrap: true,
  background: true,
  theme: "dark",
  fileFormat: "png",
  fileQuality: "standard",
  fileScale: DEFAULT_IMAGE_QUALITY_PROFILES.standard.scale,
  fileMaxWidth: DEFAULT_IMAGE_QUALITY_PROFILES.standard.maxWidth,
  mode: "both",
  ttlSeconds: 1800,
};

const DEFAULT_DIFFS_PLUGIN_SECURITY = {
  allowRemoteViewer: false,
};

const VIEWER_BASE_URL_JSON_SCHEMA = {
  type: "string",
  format: "uri",
  pattern: "^[Hh][Tt][Tt][Pp][Ss]?://",
  not: {
    pattern: "[?#]",
  },
} as const satisfies Record<string, unknown>;

const DiffsPluginJsonSchemaSource = z.strictObject({
  viewerBaseUrl: z
    .string()
    .superRefine((value, ctx) => {
      try {
        normalizeViewerBaseUrl(value, "viewerBaseUrl");
      } catch (error) {
        ctx.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid viewerBaseUrl",
        });
      }
    })
    .optional(),
  defaults: z
    .strictObject({
      fontFamily: z.string().default(DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily).optional(),
      fontSize: z.number().min(10).max(24).default(DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize).optional(),
      lineSpacing: z
        .number()
        .min(1)
        .max(3)
        .default(DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing)
        .optional(),
      layout: z.enum(DIFF_LAYOUTS).default(DEFAULT_DIFFS_TOOL_DEFAULTS.layout).optional(),
      showLineNumbers: z.boolean().default(DEFAULT_DIFFS_TOOL_DEFAULTS.showLineNumbers).optional(),
      diffIndicators: z
        .enum(DIFF_INDICATORS)
        .default(DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators)
        .optional(),
      wordWrap: z.boolean().default(DEFAULT_DIFFS_TOOL_DEFAULTS.wordWrap).optional(),
      background: z.boolean().default(DEFAULT_DIFFS_TOOL_DEFAULTS.background).optional(),
      theme: z.enum(DIFF_THEMES).default(DEFAULT_DIFFS_TOOL_DEFAULTS.theme).optional(),
      fileFormat: z.enum(DIFF_OUTPUT_FORMATS).optional(),
      format: z.enum(DIFF_OUTPUT_FORMATS).optional().describe("Deprecated alias for fileFormat."),
      fileQuality: z.enum(DIFF_IMAGE_QUALITY_PRESETS).optional(),
      fileScale: z.number().min(1).max(4).optional(),
      fileMaxWidth: z.number().min(640).max(2400).optional(),
      imageFormat: z
        .enum(DIFF_OUTPUT_FORMATS)
        .optional()
        .describe("Deprecated alias for fileFormat."),
      imageQuality: z
        .enum(DIFF_IMAGE_QUALITY_PRESETS)
        .optional()
        .describe("Deprecated alias for fileQuality."),
      imageScale: z.number().min(1).max(4).optional().describe("Deprecated alias for fileScale."),
      imageMaxWidth: z
        .number()
        .min(640)
        .max(2400)
        .optional()
        .describe("Deprecated alias for fileMaxWidth."),
      mode: z.enum(DIFF_MODES).default(DEFAULT_DIFFS_TOOL_DEFAULTS.mode).optional(),
      ttlSeconds: z
        .number()
        .min(1)
        .max(21_600)
        .default(DEFAULT_DIFFS_TOOL_DEFAULTS.ttlSeconds)
        .optional(),
    })
    .optional(),
  security: z
    .strictObject({
      allowRemoteViewer: z
        .boolean()
        .default(DEFAULT_DIFFS_PLUGIN_SECURITY.allowRemoteViewer)
        .optional(),
    })
    .optional(),
});

const diffsPluginConfigSchemaBase = buildPluginConfigSchema(DiffsPluginJsonSchemaSource, {
  safeParse(value: unknown) {
    if (value === undefined) {
      return { success: true, data: undefined };
    }
    const result = DiffsPluginJsonSchemaSource.safeParse(value);
    if (result.success) {
      return {
        success: true,
        data: buildDiffsPluginConfigShape(result.data),
      };
    }
    return {
      success: false,
      error: {
        issues: mapPluginConfigIssues(result.error.issues),
      },
    };
  },
});

export const diffsPluginConfigSchema: OpenClawPluginConfigSchema = {
  ...diffsPluginConfigSchemaBase,
  jsonSchema: {
    ...diffsPluginConfigSchemaBase.jsonSchema,
    properties: {
      ...(diffsPluginConfigSchemaBase.jsonSchema as { properties?: Record<string, unknown> })
        .properties,
      viewerBaseUrl: VIEWER_BASE_URL_JSON_SCHEMA,
    },
  },
};

function buildDiffsPluginConfigShape(config: DiffsPluginConfig): DiffsPluginConfig {
  const viewerBaseUrl = resolveDiffsPluginViewerBaseUrl(config);
  return {
    ...(viewerBaseUrl !== undefined ? { viewerBaseUrl } : {}),
    ...(config.defaults !== undefined ? { defaults: resolveDiffsPluginDefaults(config) } : {}),
    ...(config.security !== undefined ? { security: resolveDiffsPluginSecurity(config) } : {}),
  };
}

export function resolveDiffsPluginDefaults(config: unknown): DiffToolDefaults {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
  }

  const defaults = (config as DiffsPluginConfig).defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
  }

  const fileQuality = normalizeFileQuality(defaults.fileQuality ?? defaults.imageQuality);
  const profile = DEFAULT_IMAGE_QUALITY_PROFILES[fileQuality];
  const fileFormat =
    defaults.fileFormat ??
    (defaults.imageFormat !== undefined ? defaults.imageFormat : defaults.format);

  return {
    fontFamily: normalizeFontFamily(defaults.fontFamily),
    fontSize: normalizeDiffFontSize(defaults.fontSize),
    lineSpacing: normalizeDiffLineSpacing(defaults.lineSpacing),
    layout:
      DIFF_LAYOUTS.find((value) => value === defaults.layout) ?? DEFAULT_DIFFS_TOOL_DEFAULTS.layout,
    showLineNumbers: defaults.showLineNumbers !== false,
    diffIndicators:
      DIFF_INDICATORS.find((value) => value === defaults.diffIndicators) ??
      DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators,
    wordWrap: defaults.wordWrap !== false,
    background: defaults.background !== false,
    theme:
      DIFF_THEMES.find((value) => value === defaults.theme) ?? DEFAULT_DIFFS_TOOL_DEFAULTS.theme,
    fileFormat: normalizeFileFormat(fileFormat),
    fileQuality,
    fileScale: normalizeFileScale(defaults.fileScale ?? defaults.imageScale, profile.scale),
    fileMaxWidth: normalizeFileMaxWidth(
      defaults.fileMaxWidth ?? defaults.imageMaxWidth,
      profile.maxWidth,
    ),
    mode: DIFF_MODES.find((value) => value === defaults.mode) ?? DEFAULT_DIFFS_TOOL_DEFAULTS.mode,
    ttlSeconds: normalizeTtlSeconds(defaults.ttlSeconds),
  };
}

export function resolveDiffsPluginSecurity(config: unknown) {
  return {
    allowRemoteViewer:
      asOptionalRecord(asOptionalRecord(config)?.security)?.allowRemoteViewer === true,
  };
}

export function resolveDiffsPluginViewerBaseUrl(config: unknown): string | undefined {
  const viewerBaseUrl = asOptionalRecord(config)?.viewerBaseUrl;
  if (typeof viewerBaseUrl !== "string") {
    return undefined;
  }

  const normalized = viewerBaseUrl.trim();
  return normalized ? normalizeViewerBaseUrl(normalized) : undefined;
}

function normalizeFontFamily(fontFamily?: string): string {
  const normalized = fontFamily?.trim();
  return normalized || DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily;
}

export function normalizeDiffFontSize(fontSize?: number): number {
  return clampInt(asFiniteNumber(fontSize) ?? DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize, 10, 24);
}

export function normalizeDiffLineSpacing(lineSpacing?: number): number {
  return clampNumber(asFiniteNumber(lineSpacing) ?? DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing, 1, 3);
}

function normalizeFileFormat(fileFormat?: DiffOutputFormat): DiffOutputFormat {
  return fileFormat && DIFF_OUTPUT_FORMATS.includes(fileFormat)
    ? fileFormat
    : DEFAULT_DIFFS_TOOL_DEFAULTS.fileFormat;
}

function normalizeFileQuality(fileQuality?: DiffImageQualityPreset): DiffImageQualityPreset {
  return fileQuality && DIFF_IMAGE_QUALITY_PRESETS.includes(fileQuality)
    ? fileQuality
    : DEFAULT_DIFFS_TOOL_DEFAULTS.fileQuality;
}

function normalizeFileScale(fileScale: number | undefined, fallback: number): number {
  const value = asFiniteNumber(fileScale);
  return value === undefined ? fallback : clampNumber(Math.round(value * 100) / 100, 1, 4);
}

function normalizeFileMaxWidth(fileMaxWidth: number | undefined, fallback: number): number {
  const value = asFiniteNumber(fileMaxWidth);
  return value === undefined ? fallback : clampNumber(Math.round(value), 640, 2400);
}

function normalizeTtlSeconds(ttlSeconds?: number): number {
  return clampInt(asFiniteNumber(ttlSeconds) ?? DEFAULT_DIFFS_TOOL_DEFAULTS.ttlSeconds, 1, 21_600);
}

export function resolveDiffImageRenderOptions(
  params: Partial<DiffFileDefaults> & { defaults: DiffFileDefaults },
) {
  const format = normalizeFileFormat(params.fileFormat ?? params.defaults.fileFormat);
  const qualityOverrideProvided = params.fileQuality !== undefined;
  const qualityPreset = normalizeFileQuality(params.fileQuality ?? params.defaults.fileQuality);
  const profile = DEFAULT_IMAGE_QUALITY_PROFILES[qualityPreset];

  const scale = normalizeFileScale(
    params.fileScale,
    qualityOverrideProvided ? profile.scale : params.defaults.fileScale,
  );
  const maxWidth = normalizeFileMaxWidth(
    params.fileMaxWidth,
    qualityOverrideProvided ? profile.maxWidth : params.defaults.fileMaxWidth,
  );

  return {
    format,
    qualityPreset,
    scale,
    maxWidth,
    maxPixels: profile.maxPixels,
  };
}

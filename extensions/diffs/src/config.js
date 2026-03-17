import {
  DIFF_IMAGE_QUALITY_PRESETS,
  DIFF_INDICATORS,
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_OUTPUT_FORMATS,
  DIFF_THEMES
} from "./types.js";
const DEFAULT_IMAGE_QUALITY_PROFILES = {
  standard: {
    scale: 2,
    maxWidth: 960,
    maxPixels: 8e6
  },
  hq: {
    scale: 2.5,
    maxWidth: 1200,
    maxPixels: 14e6
  },
  print: {
    scale: 3,
    maxWidth: 1400,
    maxPixels: 24e6
  }
};
const DEFAULT_DIFFS_TOOL_DEFAULTS = {
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
  mode: "both"
};
const DEFAULT_DIFFS_PLUGIN_SECURITY = {
  allowRemoteViewer: false
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
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize
        },
        lineSpacing: {
          type: "number",
          minimum: 1,
          maximum: 3,
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing
        },
        layout: {
          type: "string",
          enum: [...DIFF_LAYOUTS],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.layout
        },
        showLineNumbers: {
          type: "boolean",
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.showLineNumbers
        },
        diffIndicators: {
          type: "string",
          enum: [...DIFF_INDICATORS],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators
        },
        wordWrap: { type: "boolean", default: DEFAULT_DIFFS_TOOL_DEFAULTS.wordWrap },
        background: { type: "boolean", default: DEFAULT_DIFFS_TOOL_DEFAULTS.background },
        theme: {
          type: "string",
          enum: [...DIFF_THEMES],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.theme
        },
        fileFormat: {
          type: "string",
          enum: [...DIFF_OUTPUT_FORMATS],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.fileFormat
        },
        format: {
          type: "string",
          enum: [...DIFF_OUTPUT_FORMATS]
        },
        fileQuality: {
          type: "string",
          enum: [...DIFF_IMAGE_QUALITY_PRESETS],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.fileQuality
        },
        fileScale: {
          type: "number",
          minimum: 1,
          maximum: 4,
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.fileScale
        },
        fileMaxWidth: {
          type: "number",
          minimum: 640,
          maximum: 2400,
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.fileMaxWidth
        },
        imageFormat: {
          type: "string",
          enum: [...DIFF_OUTPUT_FORMATS]
        },
        imageQuality: {
          type: "string",
          enum: [...DIFF_IMAGE_QUALITY_PRESETS]
        },
        imageScale: {
          type: "number",
          minimum: 1,
          maximum: 4
        },
        imageMaxWidth: {
          type: "number",
          minimum: 640,
          maximum: 2400
        },
        mode: {
          type: "string",
          enum: [...DIFF_MODES],
          default: DEFAULT_DIFFS_TOOL_DEFAULTS.mode
        }
      }
    },
    security: {
      type: "object",
      additionalProperties: false,
      properties: {
        allowRemoteViewer: {
          type: "boolean",
          default: DEFAULT_DIFFS_PLUGIN_SECURITY.allowRemoteViewer
        }
      }
    }
  }
};
const diffsPluginConfigSchema = {
  safeParse(value) {
    if (value === void 0) {
      return { success: true, data: void 0 };
    }
    try {
      return { success: true, data: resolveDiffsPluginDefaults(value) };
    } catch (error) {
      return {
        success: false,
        error: {
          issues: [{ path: [], message: error instanceof Error ? error.message : String(error) }]
        }
      };
    }
  },
  jsonSchema: DIFFS_PLUGIN_CONFIG_JSON_SCHEMA
};
function resolveDiffsPluginDefaults(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
  }
  const defaults = config.defaults;
  if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
    return { ...DEFAULT_DIFFS_TOOL_DEFAULTS };
  }
  const fileQuality = normalizeFileQuality(defaults.fileQuality ?? defaults.imageQuality);
  const profile = DEFAULT_IMAGE_QUALITY_PROFILES[fileQuality];
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
    fileFormat: normalizeFileFormat(defaults.fileFormat ?? defaults.imageFormat ?? defaults.format),
    fileQuality,
    fileScale: normalizeFileScale(defaults.fileScale ?? defaults.imageScale, profile.scale),
    fileMaxWidth: normalizeFileMaxWidth(
      defaults.fileMaxWidth ?? defaults.imageMaxWidth,
      profile.maxWidth
    ),
    mode: normalizeMode(defaults.mode)
  };
}
function resolveDiffsPluginSecurity(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ...DEFAULT_DIFFS_PLUGIN_SECURITY };
  }
  const security = config.security;
  if (!security || typeof security !== "object" || Array.isArray(security)) {
    return { ...DEFAULT_DIFFS_PLUGIN_SECURITY };
  }
  return {
    allowRemoteViewer: security.allowRemoteViewer === true
  };
}
function toPresentationDefaults(defaults) {
  const {
    fontFamily,
    fontSize,
    lineSpacing,
    layout,
    showLineNumbers,
    diffIndicators,
    wordWrap,
    background,
    theme
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
    theme
  };
}
function normalizeFontFamily(fontFamily) {
  const normalized = fontFamily?.trim();
  return normalized || DEFAULT_DIFFS_TOOL_DEFAULTS.fontFamily;
}
function normalizeFontSize(fontSize) {
  if (fontSize === void 0 || !Number.isFinite(fontSize)) {
    return DEFAULT_DIFFS_TOOL_DEFAULTS.fontSize;
  }
  const rounded = Math.floor(fontSize);
  return Math.min(Math.max(rounded, 10), 24);
}
function normalizeLineSpacing(lineSpacing) {
  if (lineSpacing === void 0 || !Number.isFinite(lineSpacing)) {
    return DEFAULT_DIFFS_TOOL_DEFAULTS.lineSpacing;
  }
  return Math.min(Math.max(lineSpacing, 1), 3);
}
function normalizeLayout(layout) {
  return layout && DIFF_LAYOUTS.includes(layout) ? layout : DEFAULT_DIFFS_TOOL_DEFAULTS.layout;
}
function normalizeDiffIndicators(diffIndicators) {
  return diffIndicators && DIFF_INDICATORS.includes(diffIndicators) ? diffIndicators : DEFAULT_DIFFS_TOOL_DEFAULTS.diffIndicators;
}
function normalizeTheme(theme) {
  return theme && DIFF_THEMES.includes(theme) ? theme : DEFAULT_DIFFS_TOOL_DEFAULTS.theme;
}
function normalizeFileFormat(fileFormat) {
  return fileFormat && DIFF_OUTPUT_FORMATS.includes(fileFormat) ? fileFormat : DEFAULT_DIFFS_TOOL_DEFAULTS.fileFormat;
}
function normalizeFileQuality(fileQuality) {
  return fileQuality && DIFF_IMAGE_QUALITY_PRESETS.includes(fileQuality) ? fileQuality : DEFAULT_DIFFS_TOOL_DEFAULTS.fileQuality;
}
function normalizeFileScale(fileScale, fallback) {
  if (fileScale === void 0 || !Number.isFinite(fileScale)) {
    return fallback;
  }
  const rounded = Math.round(fileScale * 100) / 100;
  return Math.min(Math.max(rounded, 1), 4);
}
function normalizeFileMaxWidth(fileMaxWidth, fallback) {
  if (fileMaxWidth === void 0 || !Number.isFinite(fileMaxWidth)) {
    return fallback;
  }
  const rounded = Math.round(fileMaxWidth);
  return Math.min(Math.max(rounded, 640), 2400);
}
function normalizeMode(mode) {
  return mode && DIFF_MODES.includes(mode) ? mode : DEFAULT_DIFFS_TOOL_DEFAULTS.mode;
}
function resolveDiffImageRenderOptions(params) {
  const format = normalizeFileFormat(
    params.fileFormat ?? params.imageFormat ?? params.format ?? params.defaults.fileFormat
  );
  const qualityOverrideProvided = params.fileQuality !== void 0 || params.imageQuality !== void 0;
  const qualityPreset = normalizeFileQuality(
    params.fileQuality ?? params.imageQuality ?? params.defaults.fileQuality
  );
  const profile = DEFAULT_IMAGE_QUALITY_PROFILES[qualityPreset];
  const scale = normalizeFileScale(
    params.fileScale ?? params.imageScale,
    qualityOverrideProvided ? profile.scale : params.defaults.fileScale
  );
  const maxWidth = normalizeFileMaxWidth(
    params.fileMaxWidth ?? params.imageMaxWidth,
    qualityOverrideProvided ? profile.maxWidth : params.defaults.fileMaxWidth
  );
  return {
    format,
    qualityPreset,
    scale,
    maxWidth,
    maxPixels: profile.maxPixels
  };
}
export {
  DEFAULT_DIFFS_PLUGIN_SECURITY,
  DEFAULT_DIFFS_TOOL_DEFAULTS,
  diffsPluginConfigSchema,
  resolveDiffImageRenderOptions,
  resolveDiffsPluginDefaults,
  resolveDiffsPluginSecurity,
  toPresentationDefaults
};

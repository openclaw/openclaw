import fs from "node:fs/promises";
import { Static, Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PlaywrightDiffScreenshotter, type DiffScreenshotter } from "./browser.js";
import { resolveDiffImageRenderOptions } from "./config.js";
import { renderDiffDocument } from "./render.js";
import type { DiffArtifactStore } from "./store.js";
import type { DiffRenderOptions, DiffToolDefaults } from "./types.js";
import {
  DIFF_IMAGE_QUALITY_PRESETS,
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_OUTPUT_FORMATS,
  DIFF_THEMES,
  type DiffInput,
  type DiffImageQualityPreset,
  type DiffLayout,
  type DiffMode,
  type DiffOutputFormat,
  type DiffTheme,
} from "./types.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";

const MAX_BEFORE_AFTER_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_BYTES = 1_024;
const MAX_PATH_BYTES = 2_048;
const MAX_LANG_BYTES = 128;

function stringEnum<T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: [...values],
    description,
  });
}

const DiffsToolSchema = Type.Object(
  {
    before: Type.Optional(Type.String({ description: "Original text content." })),
    after: Type.Optional(Type.String({ description: "Updated text content." })),
    patch: Type.Optional(
      Type.String({
        description: "Unified diff or patch text.",
        maxLength: MAX_PATCH_BYTES,
      }),
    ),
    path: Type.Optional(
      Type.String({
        description: "Display path for before/after input.",
        maxLength: MAX_PATH_BYTES,
      }),
    ),
    lang: Type.Optional(
      Type.String({
        description: "Optional language override for before/after input.",
        maxLength: MAX_LANG_BYTES,
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: "Optional title for the rendered diff.",
        maxLength: MAX_TITLE_BYTES,
      }),
    ),
    mode: Type.Optional(
      stringEnum(DIFF_MODES, "Output mode: view, file, image, or both. Default: both."),
    ),
    theme: Type.Optional(stringEnum(DIFF_THEMES, "Viewer theme. Default: dark.")),
    layout: Type.Optional(stringEnum(DIFF_LAYOUTS, "Diff layout. Default: unified.")),
    fileQuality: Type.Optional(
      stringEnum(DIFF_IMAGE_QUALITY_PRESETS, "File quality preset: standard, hq, or print."),
    ),
    fileFormat: Type.Optional(stringEnum(DIFF_OUTPUT_FORMATS, "Rendered file format: png or pdf.")),
    fileScale: Type.Optional(
      Type.Number({
        description: "Optional rendered-file device scale factor override (1-4).",
        minimum: 1,
        maximum: 4,
      }),
    ),
    fileMaxWidth: Type.Optional(
      Type.Number({
        description: "Optional rendered-file max width in CSS pixels (640-2400).",
        minimum: 640,
        maximum: 2400,
      }),
    ),
    imageQuality: Type.Optional(
      stringEnum(DIFF_IMAGE_QUALITY_PRESETS, "Deprecated alias for fileQuality."),
    ),
    imageFormat: Type.Optional(stringEnum(DIFF_OUTPUT_FORMATS, "Deprecated alias for fileFormat.")),
    imageScale: Type.Optional(
      Type.Number({
        description: "Deprecated alias for fileScale.",
        minimum: 1,
        maximum: 4,
      }),
    ),
    imageMaxWidth: Type.Optional(
      Type.Number({
        description: "Deprecated alias for fileMaxWidth.",
        minimum: 640,
        maximum: 2400,
      }),
    ),
    expandUnchanged: Type.Optional(
      Type.Boolean({ description: "Expand unchanged sections instead of collapsing them." }),
    ),
    ttlSeconds: Type.Optional(
      Type.Number({
        description: "Artifact lifetime in seconds. Default: 1800. Maximum: 21600.",
        minimum: 1,
        maximum: 21_600,
      }),
    ),
    baseUrl: Type.Optional(
      Type.String({
        description:
          "Optional gateway base URL override used when building the viewer URL, for example https://gateway.example.com.",
      }),
    ),
  },
  { additionalProperties: false },
);

type DiffsToolParams = Static<typeof DiffsToolSchema>;
type DiffsToolRawParams = DiffsToolParams & {
  // Keep backward compatibility for direct calls that still pass `format`.
  format?: DiffOutputFormat;
};

export function createDiffsTool(params: {
  api: OpenClawPluginApi;
  store: DiffArtifactStore;
  defaults: DiffToolDefaults;
  screenshotter?: DiffScreenshotter;
}): AnyAgentTool {
  return {
    name: "diffs",
    label: "Diffs",
    description:
      "Create a read-only diff viewer from before/after text or a unified patch. Returns a gateway viewer URL for canvas use and can also render the same diff to a PNG or PDF.",
    parameters: DiffsToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const toolParams = rawParams as DiffsToolRawParams;
      const input = normalizeDiffInput(toolParams);
      const mode = normalizeMode(toolParams.mode, params.defaults.mode);
      const theme = normalizeTheme(toolParams.theme, params.defaults.theme);
      const layout = normalizeLayout(toolParams.layout, params.defaults.layout);
      const expandUnchanged = toolParams.expandUnchanged === true;
      const ttlMs = normalizeTtlMs(toolParams.ttlSeconds);
      const image = resolveDiffImageRenderOptions({
        defaults: params.defaults,
        fileFormat: normalizeOutputFormat(
          toolParams.fileFormat ?? toolParams.imageFormat ?? toolParams.format,
        ),
        fileQuality: normalizeFileQuality(toolParams.fileQuality ?? toolParams.imageQuality),
        fileScale: toolParams.fileScale ?? toolParams.imageScale,
        fileMaxWidth: toolParams.fileMaxWidth ?? toolParams.imageMaxWidth,
      });

      const rendered = await renderDiffDocument(input, {
        presentation: {
          ...params.defaults,
          layout,
          theme,
        },
        image,
        expandUnchanged,
      });

      const screenshotter =
        params.screenshotter ?? new PlaywrightDiffScreenshotter({ config: params.api.config });

      if (isArtifactOnlyMode(mode)) {
        const artifactFile = await renderDiffArtifactFile({
          screenshotter,
          store: params.store,
          html: rendered.imageHtml,
          theme,
          image,
          ttlMs,
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Diff ${image.format.toUpperCase()} generated at: ${artifactFile.path}\n` +
                "Use the `message` tool with `path` or `filePath` to send this file.",
            },
          ],
          details: {
            title: rendered.title,
            inputKind: rendered.inputKind,
            fileCount: rendered.fileCount,
            mode,
            filePath: artifactFile.path,
            imagePath: artifactFile.path,
            path: artifactFile.path,
            fileBytes: artifactFile.bytes,
            imageBytes: artifactFile.bytes,
            format: image.format,
            fileFormat: image.format,
            fileQuality: image.qualityPreset,
            imageQuality: image.qualityPreset,
            fileScale: image.scale,
            imageScale: image.scale,
            fileMaxWidth: image.maxWidth,
            imageMaxWidth: image.maxWidth,
          },
        };
      }

      const artifact = await params.store.createArtifact({
        html: rendered.html,
        title: rendered.title,
        inputKind: rendered.inputKind,
        fileCount: rendered.fileCount,
        ttlMs,
      });

      const viewerUrl = buildViewerUrl({
        config: params.api.config,
        viewerPath: artifact.viewerPath,
        baseUrl: normalizeBaseUrl(toolParams.baseUrl),
      });

      const baseDetails = {
        artifactId: artifact.id,
        viewerUrl,
        viewerPath: artifact.viewerPath,
        title: artifact.title,
        expiresAt: artifact.expiresAt,
        inputKind: artifact.inputKind,
        fileCount: artifact.fileCount,
        mode,
      };

      if (mode === "view") {
        return {
          content: [
            {
              type: "text",
              text: `Diff viewer ready.\n${viewerUrl}`,
            },
          ],
          details: baseDetails,
        };
      }

      try {
        const artifactFile = await renderDiffArtifactFile({
          screenshotter,
          store: params.store,
          artifactId: artifact.id,
          html: rendered.imageHtml,
          theme,
          image,
        });
        await params.store.updateFilePath(artifact.id, artifactFile.path);

        return {
          content: [
            {
              type: "text",
              text:
                `Diff viewer: ${viewerUrl}\n` +
                `Diff ${image.format.toUpperCase()} generated at: ${artifactFile.path}\n` +
                "Use the `message` tool with `path` or `filePath` to send this file.",
            },
          ],
          details: {
            ...baseDetails,
            filePath: artifactFile.path,
            imagePath: artifactFile.path,
            path: artifactFile.path,
            fileBytes: artifactFile.bytes,
            imageBytes: artifactFile.bytes,
            format: image.format,
            fileFormat: image.format,
            fileQuality: image.qualityPreset,
            imageQuality: image.qualityPreset,
            fileScale: image.scale,
            imageScale: image.scale,
            fileMaxWidth: image.maxWidth,
            imageMaxWidth: image.maxWidth,
          },
        };
      } catch (error) {
        if (mode === "both") {
          return {
            content: [
              {
                type: "text",
                text:
                  `Diff viewer ready.\n${viewerUrl}\n` +
                  `File rendering failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: {
              ...baseDetails,
              fileError: error instanceof Error ? error.message : String(error),
              imageError: error instanceof Error ? error.message : String(error),
            },
          };
        }
        throw error;
      }
    },
  };
}

function normalizeFileQuality(
  fileQuality: DiffImageQualityPreset | undefined,
): DiffImageQualityPreset | undefined {
  return fileQuality && DIFF_IMAGE_QUALITY_PRESETS.includes(fileQuality) ? fileQuality : undefined;
}

function normalizeOutputFormat(format: DiffOutputFormat | undefined): DiffOutputFormat | undefined {
  return format && DIFF_OUTPUT_FORMATS.includes(format) ? format : undefined;
}

function isArtifactOnlyMode(mode: DiffMode): mode is "image" | "file" {
  return mode === "image" || mode === "file";
}

async function renderDiffArtifactFile(params: {
  screenshotter: DiffScreenshotter;
  store: DiffArtifactStore;
  artifactId?: string;
  html: string;
  theme: DiffTheme;
  image: DiffRenderOptions["image"];
  ttlMs?: number;
}): Promise<{ path: string; bytes: number }> {
  const outputPath = params.artifactId
    ? params.store.allocateFilePath(params.artifactId, params.image.format)
    : (
        await params.store.createStandaloneFileArtifact({
          format: params.image.format,
          ttlMs: params.ttlMs,
        })
      ).filePath;

  await params.screenshotter.screenshotHtml({
    html: params.html,
    outputPath,
    theme: params.theme,
    image: params.image,
  });

  const stats = await fs.stat(outputPath);
  return {
    path: outputPath,
    bytes: stats.size,
  };
}

function normalizeDiffInput(params: DiffsToolParams): DiffInput {
  const patch = params.patch?.trim();
  const before = params.before;
  const after = params.after;

  if (patch) {
    assertMaxBytes(patch, "patch", MAX_PATCH_BYTES);
    if (before !== undefined || after !== undefined) {
      throw new PluginToolInputError("Provide either patch or before/after input, not both.");
    }
    const title = params.title?.trim();
    if (title) {
      assertMaxBytes(title, "title", MAX_TITLE_BYTES);
    }
    return {
      kind: "patch",
      patch,
      title,
    };
  }

  if (before === undefined || after === undefined) {
    throw new PluginToolInputError("Provide patch or both before and after text.");
  }
  assertMaxBytes(before, "before", MAX_BEFORE_AFTER_BYTES);
  assertMaxBytes(after, "after", MAX_BEFORE_AFTER_BYTES);
  const path = params.path?.trim() || undefined;
  const lang = params.lang?.trim() || undefined;
  const title = params.title?.trim() || undefined;
  if (path) {
    assertMaxBytes(path, "path", MAX_PATH_BYTES);
  }
  if (lang) {
    assertMaxBytes(lang, "lang", MAX_LANG_BYTES);
  }
  if (title) {
    assertMaxBytes(title, "title", MAX_TITLE_BYTES);
  }

  return {
    kind: "before_after",
    before,
    after,
    path,
    lang,
    title,
  };
}

function assertMaxBytes(value: string, label: string, maxBytes: number): void {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return;
  }
  throw new PluginToolInputError(`${label} exceeds maximum size (${maxBytes} bytes).`);
}

function normalizeBaseUrl(baseUrl?: string): string | undefined {
  const normalized = baseUrl?.trim();
  if (!normalized) {
    return undefined;
  }
  try {
    return normalizeViewerBaseUrl(normalized);
  } catch {
    throw new PluginToolInputError(`Invalid baseUrl: ${normalized}`);
  }
}

function normalizeMode(mode: DiffMode | undefined, fallback: DiffMode): DiffMode {
  return mode && DIFF_MODES.includes(mode) ? mode : fallback;
}

function normalizeTheme(theme: DiffTheme | undefined, fallback: DiffTheme): DiffTheme {
  return theme && DIFF_THEMES.includes(theme) ? theme : fallback;
}

function normalizeLayout(layout: DiffLayout | undefined, fallback: DiffLayout): DiffLayout {
  return layout && DIFF_LAYOUTS.includes(layout) ? layout : fallback;
}

function normalizeTtlMs(ttlSeconds?: number): number | undefined {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds === undefined) {
    return undefined;
  }
  return Math.floor(ttlSeconds * 1000);
}

class PluginToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

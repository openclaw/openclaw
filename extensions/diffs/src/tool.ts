import fs from "node:fs/promises";
import { optionalFiniteNumberSchema, stringEnum } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { readFiniteNumberParam } from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool, OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  asNonArrayRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import type { Static } from "typebox";
import { resolveDiffImageRenderOptions } from "./config.js";
import { DiffRenderInputError, renderDiffDocument } from "./render.js";
import type { DiffArtifactStore } from "./store.js";
import {
  type DiffArtifactContext,
  type DiffRenderTarget,
  type DiffToolDefaults,
  DIFF_IMAGE_QUALITY_PRESETS,
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_OUTPUT_FORMATS,
  DIFF_THEMES,
  type DiffInput,
  type DiffMode,
} from "./types.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";

const MAX_BEFORE_AFTER_BYTES = 512 * 1024;
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
const MAX_TITLE_BYTES = 1_024;
const MAX_PATH_BYTES = 2_048;
const MAX_LANG_BYTES = 128;
const MAX_DIFF_ARTIFACT_TTL_SECONDS = 21_600;
const loadDiffsBrowserRuntime = createLazyRuntimeModule(() => import("./browser.runtime.js"));

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
      stringEnum(DIFF_MODES, {
        description:
          "Output mode: view, file, image (deprecated alias for file), or both. Default: both.",
      }),
    ),
    theme: Type.Optional(stringEnum(DIFF_THEMES, { description: "Viewer theme. Default: dark." })),
    layout: Type.Optional(
      stringEnum(DIFF_LAYOUTS, { description: "Diff layout. Default: unified." }),
    ),
    fileQuality: Type.Optional(
      stringEnum(DIFF_IMAGE_QUALITY_PRESETS, {
        description: "File quality preset: standard, hq, or print.",
      }),
    ),
    fileFormat: Type.Optional(
      stringEnum(DIFF_OUTPUT_FORMATS, { description: "Rendered file format: png or pdf." }),
    ),
    fileScale: optionalFiniteNumberSchema({
      description: "Optional rendered-file device scale factor override (1-4).",
      minimum: 1,
      maximum: 4,
    }),
    fileMaxWidth: optionalFiniteNumberSchema({
      description: "Optional rendered-file max width in CSS pixels (640-2400).",
      minimum: 640,
      maximum: 2400,
    }),
    expandUnchanged: Type.Optional(
      Type.Boolean({ description: "Expand unchanged sections instead of collapsing them." }),
    ),
    ttlSeconds: optionalFiniteNumberSchema({
      description: "Artifact lifetime in seconds. Default: 1800. Maximum: 21600.",
      minimum: 1,
      maximum: MAX_DIFF_ARTIFACT_TTL_SECONDS,
    }),
    baseUrl: Type.Optional(
      Type.String({
        description:
          "Optional gateway base URL override used when building the viewer URL. Overrides configured viewerBaseUrl, for example https://gateway.example.com.",
      }),
    ),
  },
  { additionalProperties: false },
);

type DiffsToolParams = Static<typeof DiffsToolSchema>;

export function createDiffsTool(params: {
  getConfig: () => OpenClawConfig;
  store: DiffArtifactStore;
  defaults: DiffToolDefaults;
  viewerBaseUrl?: string;
  languagePackAvailable?: boolean;
  context?: OpenClawPluginToolContext;
}): AnyAgentTool {
  return {
    name: "diffs",
    label: "Diffs",
    description:
      "Create a read-only diff viewer from before/after text or a unified patch. Returns a gateway viewer URL for interactive viewing and can also render the same diff to a PNG or PDF.",
    parameters: DiffsToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const config = params.getConfig();
      const toolParams = asNonArrayRecord(rawParams) as DiffsToolParams;
      const rawRecord = toolParams as Record<string, unknown>;
      const artifactContext = buildArtifactContext(params.context);
      const input = normalizeDiffInput(toolParams);
      if (input.kind === "before_after" && input.before === input.after) {
        return textResult("Before and after are identical — no changes to render.", {
          changed: false,
          ...(artifactContext ? { context: artifactContext } : {}),
        });
      }
      const mode = DIFF_MODES.find((value) => value === toolParams.mode) ?? params.defaults.mode;
      const theme =
        DIFF_THEMES.find((value) => value === toolParams.theme) ?? params.defaults.theme;
      const layout =
        DIFF_LAYOUTS.find((value) => value === toolParams.layout) ?? params.defaults.layout;
      const expandUnchanged = toolParams.expandUnchanged === true;
      const ttlSeconds =
        readFiniteNumberParam(rawRecord, "ttlSeconds") ?? params.defaults.ttlSeconds;
      const fileScale = readFiniteNumberParam(rawRecord, "fileScale");
      const fileMaxWidth = readFiniteNumberParam(rawRecord, "fileMaxWidth");
      const ttlMs = normalizeTtlMs(ttlSeconds);
      const image = resolveDiffImageRenderOptions({
        defaults: params.defaults,
        fileFormat: DIFF_OUTPUT_FORMATS.find((value) => value === toolParams.fileFormat),
        fileQuality: DIFF_IMAGE_QUALITY_PRESETS.find((value) => value === toolParams.fileQuality),
        fileScale,
        fileMaxWidth,
      });
      const renderTarget = resolveRenderTarget(mode);

      const rendered = await renderDiffDocument(
        input,
        {
          presentation: {
            ...params.defaults,
            layout,
            theme,
          },
          image,
          expandUnchanged,
          languagePackAvailable: params.languagePackAvailable,
        },
        renderTarget,
      ).catch((error: unknown) => {
        if (error instanceof DiffRenderInputError) {
          throw new PluginToolInputError(error.message);
        }
        throw error;
      });

      const artifact = isArtifactOnlyMode(mode)
        ? undefined
        : await params.store.createArtifact({
            html: requireRenderedHtml(rendered.html, "viewer"),
            title: rendered.title,
            inputKind: rendered.inputKind,
            fileCount: rendered.fileCount,
            ttlMs,
            context: artifactContext,
          });
      const viewerUrl = artifact
        ? buildViewerUrl({
            config,
            viewerPath: artifact.viewerPath,
            baseUrl: normalizeBaseUrl(toolParams.baseUrl),
            viewerBaseUrl: params.viewerBaseUrl,
          })
        : undefined;
      const viewerDetails = artifact
        ? {
            changed: true,
            artifactId: artifact.id,
            viewerUrl,
            viewerPath: artifact.viewerPath,
            title: artifact.title,
            expiresAt: artifact.expiresAt,
            inputKind: artifact.inputKind,
            fileCount: artifact.fileCount,
            mode,
            ...(artifactContext ? { context: artifactContext } : {}),
          }
        : undefined;

      if (mode === "view") {
        return textResult(`Diff viewer ready.\n${viewerUrl}`, viewerDetails);
      }

      try {
        const screenshotter = new (await loadDiffsBrowserRuntime()).PlaywrightDiffScreenshotter({
          config,
        });
        const html = requireRenderedHtml(rendered.imageHtml, "image");
        const artifactFile = await params.store.createStandaloneFileArtifact({
          format: image.format,
          ttlMs,
          context: artifactContext,
        });
        let fileBytes: number;
        try {
          await screenshotter.screenshotHtml({
            html,
            outputPath: artifactFile.filePath,
            theme,
            image,
          });
          fileBytes = (await fs.stat(artifactFile.filePath)).size;
          await params.store.completeFileArtifact(artifactFile.id);
        } catch (error) {
          await params.store.deleteFileArtifact(artifactFile.id);
          throw error;
        }

        return textResult(
          [
            ...(viewerUrl ? [`Diff viewer: ${viewerUrl}`] : []),
            `Diff ${image.format.toUpperCase()} generated at: ${artifactFile.filePath}`,
            "To send this file, use an available file-sending tool to send it as an attachment.",
          ].join("\n"),
          {
            ...(viewerDetails ?? {
              changed: true,
              artifactId: artifactFile.id,
              expiresAt: artifactFile.expiresAt,
              title: rendered.title,
              inputKind: rendered.inputKind,
              fileCount: rendered.fileCount,
              mode,
              ...(artifactContext ? { context: artifactContext } : {}),
            }),
            filePath: artifactFile.filePath,
            // `path` mirrors filePath so the message tool can send the artifact directly.
            path: artifactFile.filePath,
            fileBytes,
            fileFormat: image.format,
            fileQuality: image.qualityPreset,
            fileScale: image.scale,
            fileMaxWidth: image.maxWidth,
          },
        );
      } catch (error) {
        if (mode === "both") {
          const errorMessage = formatErrorMessage(error);
          return textResult(
            `Diff viewer ready.\n${viewerUrl}\nFile rendering failed: ${errorMessage}`,
            {
              ...viewerDetails,
              fileError: errorMessage,
            },
          );
        }
        throw error;
      }
    },
  };
}

function isArtifactOnlyMode(mode: DiffMode): mode is "image" | "file" {
  return mode === "image" || mode === "file";
}

function resolveRenderTarget(mode: DiffMode): DiffRenderTarget {
  if (mode === "view") {
    return "viewer";
  }
  if (isArtifactOnlyMode(mode)) {
    return "image";
  }
  return "both";
}

function requireRenderedHtml(html: string | undefined, target: DiffRenderTarget): string {
  if (html !== undefined) {
    return html;
  }
  throw new Error(`Missing ${target} render output.`);
}

function buildArtifactContext(
  context: OpenClawPluginToolContext | undefined,
): DiffArtifactContext | undefined {
  if (!context) {
    return undefined;
  }

  const artifactContext: DiffArtifactContext = {};
  for (const key of ["agentId", "sessionId", "messageChannel", "agentAccountId"] as const) {
    const value = normalizeOptionalString(context[key]);
    if (value) {
      artifactContext[key] = value;
    }
  }

  return Object.keys(artifactContext).length > 0 ? artifactContext : undefined;
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
  const path = normalizeOptionalString(params.path);
  const lang = normalizeOptionalString(params.lang);
  const title = normalizeOptionalString(params.title);
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

function normalizeTtlMs(ttlSeconds?: number): number | undefined {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds === undefined) {
    return undefined;
  }
  return Math.floor(Math.min(Math.max(ttlSeconds, 1), MAX_DIFF_ARTIFACT_TTL_SECONDS) * 1000);
}

class PluginToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

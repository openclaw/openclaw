import fs from "node:fs/promises";
import { Static, Type } from "@sinclair/typebox";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { PlaywrightDiffScreenshotter, type DiffScreenshotter } from "./browser.js";
import { renderDiffDocument } from "./render.js";
import type { DiffArtifactStore } from "./store.js";
import type { DiffToolDefaults } from "./types.js";
import {
  DIFF_LAYOUTS,
  DIFF_MODES,
  DIFF_THEMES,
  type DiffInput,
  type DiffLayout,
  type DiffMode,
  type DiffTheme,
} from "./types.js";
import { buildViewerUrl, normalizeViewerBaseUrl } from "./url.js";

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
    patch: Type.Optional(Type.String({ description: "Unified diff or patch text." })),
    path: Type.Optional(Type.String({ description: "Display path for before/after input." })),
    lang: Type.Optional(
      Type.String({ description: "Optional language override for before/after input." }),
    ),
    title: Type.Optional(Type.String({ description: "Optional title for the rendered diff." })),
    mode: Type.Optional(
      stringEnum(DIFF_MODES, "Output mode: view, image, or both. Default: both."),
    ),
    theme: Type.Optional(stringEnum(DIFF_THEMES, "Viewer theme. Default: dark.")),
    layout: Type.Optional(stringEnum(DIFF_LAYOUTS, "Diff layout. Default: unified.")),
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
      "Create a read-only diff viewer from before/after text or a unified patch. Returns a gateway viewer URL for canvas use and can also render the same diff to a PNG.",
    parameters: DiffsToolSchema,
    execute: async (_toolCallId, rawParams) => {
      const toolParams = rawParams as DiffsToolParams;
      const input = normalizeDiffInput(toolParams);
      const mode = normalizeMode(toolParams.mode, params.defaults.mode);
      const theme = normalizeTheme(toolParams.theme, params.defaults.theme);
      const layout = normalizeLayout(toolParams.layout, params.defaults.layout);
      const expandUnchanged = toolParams.expandUnchanged === true;
      const ttlMs = normalizeTtlMs(toolParams.ttlSeconds);

      const rendered = await renderDiffDocument(input, {
        presentation: {
          ...params.defaults,
          layout,
          theme,
        },
        expandUnchanged,
      });

      const screenshotter =
        params.screenshotter ?? new PlaywrightDiffScreenshotter({ config: params.api.config });

      if (mode === "image") {
        const imagePath = params.store.allocateStandaloneImagePath();
        await screenshotter.screenshotHtml({
          html: rendered.imageHtml,
          outputPath: imagePath,
          theme,
        });
        const imageStats = await fs.stat(imagePath);

        return {
          content: [
            {
              type: "text",
              text:
                `Diff image generated at: ${imagePath}\n` +
                "Use the `message` tool with `path` or `filePath` to send the PNG.",
            },
          ],
          details: {
            title: rendered.title,
            inputKind: rendered.inputKind,
            fileCount: rendered.fileCount,
            mode,
            imagePath,
            path: imagePath,
            imageBytes: imageStats.size,
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
        const imagePath = params.store.allocateImagePath(artifact.id);
        await screenshotter.screenshotHtml({
          html: rendered.imageHtml,
          outputPath: imagePath,
          theme,
        });
        await params.store.updateImagePath(artifact.id, imagePath);
        const imageStats = await fs.stat(imagePath);

        return {
          content: [
            {
              type: "text",
              text:
                `Diff viewer: ${viewerUrl}\n` +
                `Diff image generated at: ${imagePath}\n` +
                "Use the `message` tool with `path` or `filePath` to send the PNG.",
            },
          ],
          details: {
            ...baseDetails,
            imagePath,
            path: imagePath,
            imageBytes: imageStats.size,
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
                  `Image rendering failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            details: {
              ...baseDetails,
              imageError: error instanceof Error ? error.message : String(error),
            },
          };
        }
        throw error;
      }
    },
  };
}

function normalizeDiffInput(params: DiffsToolParams): DiffInput {
  const patch = params.patch?.trim();
  const before = params.before;
  const after = params.after;

  if (patch) {
    if (before !== undefined || after !== undefined) {
      throw new PluginToolInputError("Provide either patch or before/after input, not both.");
    }
    return {
      kind: "patch",
      patch,
      title: params.title?.trim() || undefined,
    };
  }

  if (before === undefined || after === undefined) {
    throw new PluginToolInputError("Provide patch or both before and after text.");
  }

  return {
    kind: "before_after",
    before,
    after,
    path: params.path?.trim() || undefined,
    lang: params.lang?.trim() || undefined,
    title: params.title?.trim() || undefined,
  };
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

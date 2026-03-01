import type { FileContents, FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";
import { parsePatchFiles } from "@pierre/diffs";
import { preloadFileDiff, preloadMultiFileDiff } from "@pierre/diffs/ssr";
import type {
  DiffInput,
  DiffRenderOptions,
  DiffViewerOptions,
  DiffViewerPayload,
  RenderedDiffDocument,
} from "./types.js";
import { VIEWER_LOADER_PATH } from "./viewer-assets.js";

const DEFAULT_FILE_NAME = "diff.txt";

function escapeCssString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeJsonScript(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function buildDiffTitle(input: DiffInput): string {
  if (input.title?.trim()) {
    return input.title.trim();
  }
  if (input.kind === "before_after") {
    return input.path?.trim() || "Text diff";
  }
  return "Patch diff";
}

function resolveBeforeAfterFileName(input: Extract<DiffInput, { kind: "before_after" }>): string {
  if (input.path?.trim()) {
    return input.path.trim();
  }
  if (input.lang?.trim()) {
    return `diff.${input.lang.trim().replace(/^\.+/, "")}`;
  }
  return DEFAULT_FILE_NAME;
}

function buildDiffOptions(options: DiffRenderOptions): DiffViewerOptions {
  const fontFamily = escapeCssString(options.presentation.fontFamily);
  const fontSize = Math.max(10, Math.floor(options.presentation.fontSize));
  const lineHeight = Math.max(20, Math.round(fontSize * 1.6));
  return {
    theme: {
      light: "pierre-light",
      dark: "pierre-dark",
    },
    diffStyle: options.presentation.layout,
    expandUnchanged: options.expandUnchanged,
    themeType: options.presentation.theme,
    backgroundEnabled: options.presentation.background,
    overflow: options.presentation.wordWrap ? "wrap" : "scroll",
    unsafeCSS: `
      :host {
        --diffs-font-family: "${fontFamily}", "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --diffs-header-font-family: "${fontFamily}", "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        --diffs-font-size: ${fontSize}px;
        --diffs-line-height: ${lineHeight}px;
      }

      [data-diffs-header] {
        min-height: 64px;
        padding-inline: 18px 14px;
      }

      [data-header-content] {
        gap: 10px;
      }

      [data-metadata] {
        gap: 10px;
      }

      .oc-diff-toolbar {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        margin-inline-start: 6px;
        flex: 0 0 auto;
      }

      .oc-diff-toolbar-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        margin: 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        opacity: 0.6;
        line-height: 0;
        overflow: visible;
        transition: opacity 120ms ease;
        flex: 0 0 auto;
      }

      .oc-diff-toolbar-button:hover {
        opacity: 1;
      }

      .oc-diff-toolbar-button[data-active="true"] {
        opacity: 0.92;
      }

      .oc-diff-toolbar-button svg {
        display: block;
        width: 16px;
        height: 16px;
        min-width: 16px;
        min-height: 16px;
        overflow: visible;
        flex: 0 0 auto;
        color: inherit;
        fill: currentColor;
        pointer-events: none;
      }
    `,
  };
}

function normalizeSupportedLanguage(value?: string): SupportedLanguages | undefined {
  const normalized = value?.trim();
  return normalized ? (normalized as SupportedLanguages) : undefined;
}

function buildPayloadLanguages(payload: {
  fileDiff?: FileDiffMetadata;
  oldFile?: FileContents;
  newFile?: FileContents;
}): SupportedLanguages[] {
  const langs = new Set<SupportedLanguages>();
  if (payload.fileDiff?.lang) {
    langs.add(payload.fileDiff.lang);
  }
  if (payload.oldFile?.lang) {
    langs.add(payload.oldFile.lang);
  }
  if (payload.newFile?.lang) {
    langs.add(payload.newFile.lang);
  }
  if (langs.size === 0) {
    langs.add("text");
  }
  return [...langs];
}

function renderDiffCard(payload: DiffViewerPayload): string {
  return `<section class="oc-diff-card">
    <diffs-container class="oc-diff-host" data-openclaw-diff-host>
      <template shadowrootmode="open">${payload.prerenderedHTML}</template>
    </diffs-container>
    <script type="application/json" data-openclaw-diff-payload>${escapeJsonScript(payload)}</script>
  </section>`;
}

function buildHtmlDocument(params: {
  title: string;
  bodyHtml: string;
  theme: DiffRenderOptions["presentation"]["theme"];
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <title>${escapeHtml(params.title)}</title>
    <style>
      * {
        box-sizing: border-box;
      }

      html {
        background: #05070b;
      }

      body {
        margin: 0;
        padding: 22px;
        font-family:
          "Fira Code",
          "SF Mono",
          Monaco,
          Consolas,
          monospace;
        background: #05070b;
        color: #f8fafc;
      }

      body[data-theme="light"] {
        background: #f3f5f8;
        color: #0f172a;
      }

      .oc-frame {
        max-width: 1560px;
        margin: 0 auto;
      }

      .oc-frame[data-render-mode="image"] {
        max-width: 1120px;
      }

      [data-openclaw-diff-root] {
        display: grid;
        gap: 18px;
      }

      .oc-diff-card {
        overflow: hidden;
        border-radius: 18px;
        border: 1px solid rgba(148, 163, 184, 0.16);
        background: rgba(15, 23, 42, 0.14);
        box-shadow: 0 18px 48px rgba(2, 6, 23, 0.22);
      }

      body[data-theme="light"] .oc-diff-card {
        border-color: rgba(148, 163, 184, 0.22);
        background: rgba(255, 255, 255, 0.92);
        box-shadow: 0 14px 32px rgba(15, 23, 42, 0.08);
      }

      .oc-diff-host {
        display: block;
      }

      .oc-frame[data-render-mode="image"] .oc-diff-card {
        min-height: 240px;
      }

      @media (max-width: 720px) {
        body {
          padding: 12px;
        }

        [data-openclaw-diff-root] {
          gap: 12px;
        }
      }
    </style>
  </head>
  <body data-theme="${params.theme}">
    <main class="oc-frame" data-render-mode="viewer">
      <div data-openclaw-diff-root>
        ${params.bodyHtml}
      </div>
    </main>
    <script type="module" src="${VIEWER_LOADER_PATH}"></script>
  </body>
</html>`;
}

async function renderBeforeAfterDiff(
  input: Extract<DiffInput, { kind: "before_after" }>,
  options: DiffRenderOptions,
): Promise<{ bodyHtml: string; fileCount: number }> {
  const fileName = resolveBeforeAfterFileName(input);
  const lang = normalizeSupportedLanguage(input.lang);
  const oldFile: FileContents = {
    name: fileName,
    contents: input.before,
    ...(lang ? { lang } : {}),
  };
  const newFile: FileContents = {
    name: fileName,
    contents: input.after,
    ...(lang ? { lang } : {}),
  };
  const payloadOptions = buildDiffOptions(options);
  const result = await preloadMultiFileDiff({
    oldFile,
    newFile,
    options: payloadOptions,
  });

  return {
    bodyHtml: renderDiffCard({
      prerenderedHTML: result.prerenderedHTML,
      oldFile: result.oldFile,
      newFile: result.newFile,
      options: payloadOptions,
      langs: buildPayloadLanguages({ oldFile: result.oldFile, newFile: result.newFile }),
    }),
    fileCount: 1,
  };
}

async function renderPatchDiff(
  input: Extract<DiffInput, { kind: "patch" }>,
  options: DiffRenderOptions,
): Promise<{ bodyHtml: string; fileCount: number }> {
  const files = parsePatchFiles(input.patch).flatMap((entry) => entry.files ?? []);
  if (files.length === 0) {
    throw new Error("Patch input did not contain any file diffs.");
  }

  const payloadOptions = buildDiffOptions(options);
  const sections = await Promise.all(
    files.map(async (fileDiff) => {
      const result = await preloadFileDiff({
        fileDiff,
        options: payloadOptions,
      });

      return renderDiffCard({
        prerenderedHTML: result.prerenderedHTML,
        fileDiff: result.fileDiff,
        options: payloadOptions,
        langs: buildPayloadLanguages({ fileDiff: result.fileDiff }),
      });
    }),
  );

  return {
    bodyHtml: sections.join("\n"),
    fileCount: files.length,
  };
}

export async function renderDiffDocument(
  input: DiffInput,
  options: DiffRenderOptions,
): Promise<RenderedDiffDocument> {
  const title = buildDiffTitle(input);
  const rendered =
    input.kind === "before_after"
      ? await renderBeforeAfterDiff(input, options)
      : await renderPatchDiff(input, options);

  return {
    html: buildHtmlDocument({
      title,
      bodyHtml: rendered.bodyHtml,
      theme: options.presentation.theme,
    }),
    title,
    fileCount: rendered.fileCount,
    inputKind: input.kind,
  };
}

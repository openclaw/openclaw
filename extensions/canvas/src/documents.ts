import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createPluginBlobStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { root as fsRoot, sanitizeUntrustedFileName } from "openclaw/plugin-sdk/security-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { resolveUserPath } from "openclaw/plugin-sdk/text-utility-runtime";
import { CANVAS_HOST_PATH } from "./host/a2ui.js";

type CanvasDocumentKind = "html_bundle" | "url_embed" | "document" | "image" | "video_asset";

type CanvasDocumentAsset = {
  logicalPath: string;
  sourcePath: string;
  contentType?: string;
};

type CanvasDocumentEntrypoint =
  | { type: "html"; value: string }
  | { type: "path"; value: string }
  | { type: "url"; value: string };

type CanvasDocumentCreateInput = {
  id?: string;
  kind: CanvasDocumentKind;
  title?: string;
  preferredHeight?: number;
  entrypoint?: CanvasDocumentEntrypoint;
  assets?: CanvasDocumentAsset[];
  surface?: "assistant_message" | "tool_card" | "sidebar";
};

type CanvasDocumentManifest = {
  id: string;
  kind: CanvasDocumentKind;
  title?: string;
  preferredHeight?: number;
  createdAt: string;
  entryUrl: string;
  localEntrypoint?: string;
  externalUrl?: string;
  surface?: "assistant_message" | "tool_card" | "sidebar";
  assets: Array<{
    logicalPath: string;
    contentType?: string;
  }>;
};

type CanvasDocumentResolvedAsset = {
  logicalPath: string;
  contentType?: string;
  url: string;
  localPath: string;
};

const CANVAS_DOCUMENTS_DIR_NAME = "documents";
const CANVAS_DOCUMENTS_PLUGIN_ID = "canvas";
const CANVAS_DOCUMENTS_NAMESPACE = "documents";
const CANVAS_DOCUMENTS_MAX_ENTRIES = 20_000;

type CanvasDocumentBlobMetadata = {
  documentId: string;
  logicalPath: string;
  role: "manifest" | "file";
  contentType?: string;
};

type CanvasDocumentStorageRoot = {
  write(logicalPath: string, value: string): Promise<void>;
  copyIn(
    logicalPath: string,
    sourcePath: string,
    options?: { contentType?: string },
  ): Promise<void>;
  flush?(): Promise<void>;
};

type CanvasDocumentBlob = {
  documentId: string;
  logicalPath: string;
  contentType?: string;
  blob: Buffer;
};

function canvasDocumentBlobStore(stateDir?: string) {
  return createPluginBlobStore<CanvasDocumentBlobMetadata>(CANVAS_DOCUMENTS_PLUGIN_ID, {
    namespace: CANVAS_DOCUMENTS_NAMESPACE,
    maxEntries: CANVAS_DOCUMENTS_MAX_ENTRIES,
    ...(stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } } : {}),
  });
}

function isPdfPathLike(value: string): boolean {
  return /\.pdf(?:[?#].*)?$/i.test(value.trim());
}

function buildPdfWrapper(url: string): string {
  const escaped = escapeHtml(url);
  return `<!doctype html><html><body style="margin:0;background:#e5e7eb;"><object data="${escaped}" type="application/pdf" style="width:100%;height:100vh;border:0;"><iframe src="${escaped}" style="width:100%;height:100vh;border:0;"></iframe><p style="padding:16px;font:14px system-ui,sans-serif;">Unable to render PDF preview. <a href="${escaped}" target="_blank" rel="noopener noreferrer">Open PDF</a>.</p></object></body></html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function normalizeLogicalPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some(
      (part) => part === "." || part === ".." || part.includes(":") || hasControlCharacter(part),
    )
  ) {
    throw new Error("canvas document logicalPath invalid");
  }
  return parts.join("/");
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function canvasDocumentId(): string {
  return `cv_${randomUUID().replaceAll("-", "")}`;
}

function normalizeCanvasDocumentId(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(normalized)
  ) {
    throw new Error("canvas document id invalid");
  }
  return normalized;
}

function resolveCanvasRootDir(rootDir?: string): string {
  if (!rootDir?.trim()) {
    throw new Error("canvas rootDir required for file-backed document storage");
  }
  return path.resolve(resolveUserPath(rootDir));
}

function resolveCanvasDocumentsDir(rootDir?: string): string {
  return path.join(resolveCanvasRootDir(rootDir), CANVAS_DOCUMENTS_DIR_NAME);
}

export function resolveCanvasDocumentDir(
  documentId: string,
  options?: { rootDir?: string; stateDir?: string },
): string {
  if (!options?.rootDir?.trim()) {
    return `sqlite:canvas/documents/${normalizeCanvasDocumentId(documentId)}`;
  }
  return path.join(resolveCanvasDocumentsDir(options?.rootDir), documentId);
}

export function buildCanvasDocumentEntryUrl(documentId: string, entrypoint: string): string {
  const normalizedEntrypoint = normalizeLogicalPath(entrypoint);
  const encodedEntrypoint = normalizedEntrypoint
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${CANVAS_HOST_PATH}/${CANVAS_DOCUMENTS_DIR_NAME}/${encodeURIComponent(documentId)}/${encodedEntrypoint}`;
}

function buildCanvasDocumentAssetUrl(documentId: string, logicalPath: string): string {
  return buildCanvasDocumentEntryUrl(documentId, logicalPath);
}

export function resolveCanvasHttpPathToLocalPath(
  requestPath: string,
  options?: { rootDir?: string; stateDir?: string },
): string | null {
  if (!options?.rootDir?.trim()) {
    return null;
  }
  const trimmed = requestPath.trim();
  const prefix = `${CANVAS_HOST_PATH}/${CANVAS_DOCUMENTS_DIR_NAME}/`;
  if (!trimmed.startsWith(prefix)) {
    return null;
  }
  const pathWithoutQuery = trimmed.replace(/[?#].*$/, "");
  const relative = pathWithoutQuery.slice(prefix.length);
  const segments = relative
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  const [rawDocumentId, ...entrySegments] = segments;
  try {
    const documentId = normalizeCanvasDocumentId(rawDocumentId);
    const normalizedEntrypoint = normalizeLogicalPath(entrySegments.join("/"));
    const documentsDir = path.resolve(resolveCanvasDocumentsDir(options?.rootDir));
    const candidatePath = path.resolve(
      resolveCanvasDocumentDir(documentId, options),
      normalizedEntrypoint,
    );
    if (
      !(candidatePath === documentsDir || candidatePath.startsWith(`${documentsDir}${path.sep}`))
    ) {
      return null;
    }
    return candidatePath;
  } catch {
    return null;
  }
}

async function createFilesystemCanvasRoot(rootDir: string): Promise<CanvasDocumentStorageRoot> {
  await fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined);
  await fs.mkdir(rootDir, { recursive: true });
  const root = await fsRoot(rootDir);
  return {
    async write(logicalPath, value) {
      await root.write(logicalPath, value);
    },
    async copyIn(logicalPath, sourcePath) {
      await root.copyIn(logicalPath, sourcePath);
    },
  };
}

async function clearSqliteCanvasDocument(documentId: string, stateDir?: string): Promise<void> {
  const store = canvasDocumentBlobStore(stateDir);
  const prefix = `${documentId}/`;
  const entries = await store.entries();
  await Promise.all(
    entries.filter((entry) => entry.key.startsWith(prefix)).map((entry) => store.delete(entry.key)),
  );
}

function createSqliteCanvasRoot(documentId: string, stateDir?: string): CanvasDocumentStorageRoot {
  const files = new Map<string, { blob: Buffer; contentType?: string }>();
  return {
    async write(logicalPath, value) {
      files.set(normalizeLogicalPath(logicalPath), {
        blob: Buffer.from(value, "utf8"),
        contentType: contentTypeForLogicalPath(logicalPath),
      });
    },
    async copyIn(logicalPath, sourcePath, options) {
      const normalized = normalizeLogicalPath(logicalPath);
      files.set(normalized, {
        blob: await fs.readFile(sourcePath),
        contentType: options?.contentType ?? contentTypeForLogicalPath(normalized),
      });
    },
    async flush() {
      await clearSqliteCanvasDocument(documentId, stateDir);
      const store = canvasDocumentBlobStore(stateDir);
      await Promise.all(
        [...files.entries()].map(([logicalPath, file]) =>
          store.register(
            `${documentId}/${logicalPath}`,
            {
              documentId,
              logicalPath,
              role: logicalPath === "manifest.json" ? "manifest" : "file",
              ...(file.contentType ? { contentType: file.contentType } : {}),
            },
            file.blob,
          ),
        ),
      );
    },
  };
}

function contentTypeForLogicalPath(logicalPath: string): string | undefined {
  const lower = logicalPath.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html; charset=utf-8";
  }
  if (lower.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (lower.endsWith(".pdf")) {
    return "application/pdf";
  }
  if (lower.endsWith(".png")) {
    return "image/png";
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  if (lower.endsWith(".gif")) {
    return "image/gif";
  }
  if (lower.endsWith(".webp")) {
    return "image/webp";
  }
  if (lower.endsWith(".mp3")) {
    return "audio/mpeg";
  }
  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }
  return undefined;
}

async function writeManifest(
  root: CanvasDocumentStorageRoot,
  manifest: CanvasDocumentManifest,
): Promise<void> {
  await root.write("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyAssets(
  root: CanvasDocumentStorageRoot,
  assets: CanvasDocumentAsset[] | undefined,
  workspaceDir: string,
): Promise<CanvasDocumentManifest["assets"]> {
  const copied: CanvasDocumentManifest["assets"] = [];
  for (const asset of assets ?? []) {
    const logicalPath = normalizeLogicalPath(asset.logicalPath);
    const sourcePath = asset.sourcePath.startsWith("~")
      ? resolveUserPath(asset.sourcePath)
      : path.isAbsolute(asset.sourcePath)
        ? path.resolve(asset.sourcePath)
        : path.resolve(workspaceDir, asset.sourcePath);
    await root.copyIn(logicalPath, sourcePath, { contentType: asset.contentType });
    copied.push({
      logicalPath,
      ...(asset.contentType ? { contentType: asset.contentType } : {}),
    });
  }
  return copied;
}

async function materializeEntrypoint(
  documentId: string,
  root: CanvasDocumentStorageRoot,
  input: CanvasDocumentCreateInput,
  workspaceDir: string,
): Promise<Pick<CanvasDocumentManifest, "entryUrl" | "localEntrypoint" | "externalUrl">> {
  const entrypoint = input.entrypoint;
  if (!entrypoint) {
    throw new Error("canvas document entrypoint required");
  }
  if (entrypoint.type === "html") {
    const fileName = "index.html";
    await root.write(fileName, entrypoint.value);
    return {
      localEntrypoint: fileName,
      entryUrl: buildCanvasDocumentEntryUrl(documentId, fileName),
    };
  }
  if (entrypoint.type === "url") {
    if (input.kind === "document" && isPdfPathLike(entrypoint.value)) {
      const fileName = "index.html";
      await root.write(fileName, buildPdfWrapper(entrypoint.value));
      return {
        localEntrypoint: fileName,
        externalUrl: entrypoint.value,
        entryUrl: buildCanvasDocumentEntryUrl(documentId, fileName),
      };
    }
    return {
      externalUrl: entrypoint.value,
      entryUrl: entrypoint.value,
    };
  }

  const resolvedPath = entrypoint.value.startsWith("~")
    ? resolveUserPath(entrypoint.value)
    : path.isAbsolute(entrypoint.value)
      ? path.resolve(entrypoint.value)
      : path.resolve(workspaceDir, entrypoint.value);

  if (input.kind === "image" || input.kind === "video_asset") {
    const copiedName = sanitizeUntrustedFileName(path.basename(resolvedPath), "asset");
    await root.copyIn(copiedName, resolvedPath);
    const wrapper =
      input.kind === "image"
        ? `<!doctype html><html><body style="margin:0;background:#0f172a;display:flex;align-items:center;justify-content:center;"><img src="${escapeHtml(copiedName)}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body></html>`
        : `<!doctype html><html><body style="margin:0;background:#0f172a;"><video src="${escapeHtml(copiedName)}" controls autoplay style="width:100%;height:100vh;object-fit:contain;background:#000;"></video></body></html>`;
    await root.write("index.html", wrapper);
    return {
      localEntrypoint: "index.html",
      entryUrl: buildCanvasDocumentEntryUrl(documentId, "index.html"),
    };
  }

  const fileName = sanitizeUntrustedFileName(path.basename(resolvedPath), "document");
  await root.copyIn(fileName, resolvedPath);
  if (input.kind === "document" && isPdfPathLike(fileName)) {
    await root.write("index.html", buildPdfWrapper(fileName));
    return {
      localEntrypoint: "index.html",
      entryUrl: buildCanvasDocumentEntryUrl(documentId, "index.html"),
    };
  }
  return {
    localEntrypoint: fileName,
    entryUrl: buildCanvasDocumentEntryUrl(documentId, fileName),
  };
}

export async function createCanvasDocument(
  input: CanvasDocumentCreateInput,
  options?: { stateDir?: string; workspaceDir?: string; canvasRootDir?: string },
): Promise<CanvasDocumentManifest> {
  const workspaceDir = options?.workspaceDir ?? process.cwd();
  const id = input.id?.trim() ? normalizeCanvasDocumentId(input.id) : canvasDocumentId();
  const fileBacked = Boolean(options?.canvasRootDir?.trim());
  const rootDir = fileBacked
    ? resolveCanvasDocumentDir(id, {
        stateDir: options?.stateDir,
        rootDir: options?.canvasRootDir,
      })
    : "";
  const root = fileBacked
    ? await createFilesystemCanvasRoot(rootDir)
    : createSqliteCanvasRoot(id, options?.stateDir);
  const assets = await copyAssets(root, input.assets, workspaceDir);
  const entry = await materializeEntrypoint(id, root, input, workspaceDir);
  const manifest: CanvasDocumentManifest = {
    id,
    kind: input.kind,
    ...(input.title?.trim() ? { title: input.title.trim() } : {}),
    ...(typeof input.preferredHeight === "number"
      ? { preferredHeight: input.preferredHeight }
      : {}),
    ...(input.surface ? { surface: input.surface } : {}),
    createdAt: new Date().toISOString(),
    entryUrl: entry.entryUrl,
    ...(entry.localEntrypoint ? { localEntrypoint: entry.localEntrypoint } : {}),
    ...(entry.externalUrl ? { externalUrl: entry.externalUrl } : {}),
    assets,
  };
  await writeManifest(root, manifest);
  await root.flush?.();
  return manifest;
}

export function resolveCanvasDocumentAssets(
  manifest: CanvasDocumentManifest,
  options?: { baseUrl?: string; stateDir?: string; canvasRootDir?: string },
): CanvasDocumentResolvedAsset[] {
  const baseUrl = options?.baseUrl?.trim().replace(/\/+$/, "");
  const fileBacked = Boolean(options?.canvasRootDir?.trim());
  const documentDir = fileBacked
    ? resolveCanvasDocumentDir(manifest.id, {
        stateDir: options?.stateDir,
        rootDir: options?.canvasRootDir,
      })
    : `sqlite:canvas/documents/${manifest.id}`;
  return manifest.assets.map((asset) => ({
    logicalPath: asset.logicalPath,
    ...(asset.contentType ? { contentType: asset.contentType } : {}),
    localPath: fileBacked
      ? path.join(documentDir, asset.logicalPath)
      : `${documentDir}/${asset.logicalPath}`,
    url: baseUrl
      ? `${baseUrl}${buildCanvasDocumentAssetUrl(manifest.id, asset.logicalPath)}`
      : buildCanvasDocumentAssetUrl(manifest.id, asset.logicalPath),
  }));
}

function parseCanvasDocumentRequestPath(requestPath: string): {
  documentId: string;
  logicalPath: string;
} | null {
  const trimmed = requestPath.trim();
  const pathWithoutQuery = trimmed.replace(/[?#].*$/, "");
  const prefix = `${CANVAS_HOST_PATH}/${CANVAS_DOCUMENTS_DIR_NAME}/`;
  const relative = pathWithoutQuery.startsWith(prefix)
    ? pathWithoutQuery.slice(prefix.length)
    : pathWithoutQuery.startsWith(`/${CANVAS_DOCUMENTS_DIR_NAME}/`)
      ? pathWithoutQuery.slice(`/${CANVAS_DOCUMENTS_DIR_NAME}/`.length)
      : null;
  if (relative == null) {
    return null;
  }
  const segments = relative
    .split("/")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .filter(Boolean);
  if (segments.length < 2) {
    return null;
  }
  try {
    return {
      documentId: normalizeCanvasDocumentId(segments[0] ?? ""),
      logicalPath: normalizeLogicalPath(segments.slice(1).join("/")),
    };
  } catch {
    return null;
  }
}

export async function readCanvasDocumentHttpBlob(
  requestPath: string,
  options?: { stateDir?: string },
): Promise<CanvasDocumentBlob | null> {
  const parsed = parseCanvasDocumentRequestPath(requestPath);
  if (!parsed) {
    return null;
  }
  const entry = await canvasDocumentBlobStore(options?.stateDir).lookup(
    `${parsed.documentId}/${parsed.logicalPath}`,
  );
  if (!entry) {
    return null;
  }
  return {
    documentId: parsed.documentId,
    logicalPath: parsed.logicalPath,
    ...(entry.metadata.contentType ? { contentType: entry.metadata.contentType } : {}),
    blob: entry.blob,
  };
}

export async function resolveCanvasHttpPathToMaterializedLocalPath(
  requestPath: string,
  options?: { stateDir?: string; rootDir?: string },
): Promise<string | null> {
  const filePath = resolveCanvasHttpPathToLocalPath(requestPath, options);
  if (filePath) {
    return filePath;
  }
  const entry = await readCanvasDocumentHttpBlob(requestPath, options);
  if (!entry) {
    return null;
  }
  const materializationDir = path.join(
    resolvePreferredOpenClawTmpDir(),
    "canvas-documents",
    entry.documentId,
  );
  await fs.mkdir(materializationDir, { recursive: true, mode: 0o700 });
  const filePathOut = path.join(
    materializationDir,
    sanitizeUntrustedFileName(path.basename(entry.logicalPath), "asset"),
  );
  await fs.writeFile(filePathOut, entry.blob);
  return filePathOut;
}

import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "openclaw/plugin-sdk/security-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeWorkspaceDataLogicalPath } from "./binding-contract.js";
import {
  CUSTOM_WIDGET_NAME_PATTERN,
  resolveWidgetDir,
  validateWidgetManifest,
  WIDGET_CONTENT_TYPES,
  type WidgetManifest,
} from "./manifest.js";
import type { WorkspaceActor, WorkspaceWidgetRegistryEntry } from "./schema.js";
import type { WorkspaceStore } from "./store.js";

const MAX_ALLOWED_ORIGINS = 16;
const MAX_URL_LENGTH = 2_048;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 5_000;
const REGISTRY_MAX_BYTES = 256 * 1024;
const BUNDLE_MAX_BYTES = 512 * 1024;
const BUNDLE_MAX_FILES = 64;
const MANIFEST_MAX_BYTES = 32 * 1024;
const REGISTRY_MAX_APPS = 100;
const APP_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TEXT_WIDGET_EXTENSIONS = new Set([
  ".html",
  ".js",
  ".css",
  ".json",
  ".svg",
  ".txt",
  ".md",
  ".csv",
]);

export type WorkspaceGalleryConfig = { allowedOrigins: string[] };

type WorkspaceGalleryApp = {
  id: string;
  title: string;
  description?: string;
  bundleUrl: string;
};

type WorkspaceGalleryRegistry = {
  schemaVersion: 1;
  apps: WorkspaceGalleryApp[];
};

type GuardedFetchOptions = Parameters<typeof fetchWithSsrFGuard>[0];
type GuardedFetchResult = Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
export type WorkspaceGalleryFetch = (options: GuardedFetchOptions) => Promise<GuardedFetchResult>;

type GalleryNetworkOptions = WorkspaceGalleryConfig & {
  fetchGuard?: WorkspaceGalleryFetch;
};

type InstallGalleryOptions = GalleryNetworkOptions & {
  actor: WorkspaceActor;
  stateDir?: string;
  store: WorkspaceStore;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(record: Record<string, unknown>, allowed: readonly string[], at: string) {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      throw new Error(`${at}.${key} is not allowed`);
    }
  }
}

function normalizeConfiguredOrigin(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) {
    throw new Error("gallery.allowedOrigins entries must be an HTTPS origin");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("gallery.allowedOrigins entries must be an HTTPS origin");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    value.trim() !== value
  ) {
    throw new Error("gallery.allowedOrigins entries must be an HTTPS origin");
  }
  return url.origin;
}

export function parseWorkspaceGalleryConfig(value: unknown): WorkspaceGalleryConfig {
  if (value === undefined) {
    return { allowedOrigins: [] };
  }
  if (!isRecord(value)) {
    throw new Error("workspaces plugin config must be an object");
  }
  assertKnownKeys(value, ["gallery"], "workspaces config");
  if (value.gallery === undefined) {
    return { allowedOrigins: [] };
  }
  if (!isRecord(value.gallery)) {
    throw new Error("gallery must be an object");
  }
  assertKnownKeys(value.gallery, ["allowedOrigins"], "gallery");
  const rawOrigins = value.gallery.allowedOrigins;
  if (!Array.isArray(rawOrigins) || rawOrigins.length > MAX_ALLOWED_ORIGINS) {
    throw new Error(`gallery.allowedOrigins must contain at most ${MAX_ALLOWED_ORIGINS} origins`);
  }
  return { allowedOrigins: [...new Set(rawOrigins.map(normalizeConfiguredOrigin))] };
}

function validateAllowedUrl(value: unknown, allowedOrigins: readonly string[], at: string): URL {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_URL_LENGTH) {
    throw new Error(`${at} must be an HTTPS URL`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${at} must be an HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${at} must be an HTTPS URL without credentials or a fragment`);
  }
  if (!allowedOrigins.includes(url.origin)) {
    throw new Error(`${at} origin is not allowed: ${url.origin}`);
  }
  return url;
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maxBytes) {
    throw new Error(`${label} exceeds ${maxBytes} bytes`);
  }
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`${label} exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

async function fetchGalleryJson(
  rawUrl: string,
  maxBytes: number,
  options: GalleryNetworkOptions,
): Promise<unknown> {
  let url = validateAllowedUrl(rawUrl, options.allowedOrigins, "gallery URL");
  const fetchGuard = options.fetchGuard ?? fetchWithSsrFGuard;
  for (let redirects = 0; ; redirects += 1) {
    const result = await fetchGuard({
      url: url.href,
      requireHttps: true,
      maxRedirects: 0,
      timeoutMs: FETCH_TIMEOUT_MS,
      policy: { allowedOrigins: [...options.allowedOrigins] },
      auditContext: "workspaces-gallery",
      init: { method: "GET", headers: { Accept: "application/json" }, redirect: "manual" },
    });
    try {
      if ([301, 302, 303, 307, 308].includes(result.response.status)) {
        if (redirects >= MAX_REDIRECTS) {
          throw new Error(`gallery request exceeded ${MAX_REDIRECTS} redirects`);
        }
        const location = result.response.headers.get("location");
        if (!location) {
          throw new Error("gallery redirect is missing a location");
        }
        url = validateAllowedUrl(new URL(location, url).href, options.allowedOrigins, "redirect");
        continue;
      }
      if (!result.response.ok) {
        throw new Error(`gallery request failed with HTTP ${result.response.status}`);
      }
      const contentType = result.response.headers.get("content-type")?.split(";", 1)[0]?.trim();
      if (contentType !== "application/json") {
        throw new Error("gallery response content type must be application/json");
      }
      const body = await readBoundedBody(result.response, maxBytes, "gallery response");
      try {
        return JSON.parse(body) as unknown;
      } catch (error) {
        throw new Error("gallery response is not valid JSON", { cause: error });
      }
    } finally {
      await result.release();
    }
  }
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  at: string,
  maxLength: number,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new Error(`${at}.${key} must be 1-${maxLength} characters`);
  }
  return value;
}

function validateRegistry(
  value: unknown,
  allowedOrigins: readonly string[],
): WorkspaceGalleryRegistry {
  if (!isRecord(value)) {
    throw new Error("gallery registry must be an object");
  }
  assertKnownKeys(value, ["schemaVersion", "apps"], "gallery registry");
  if (value.schemaVersion !== 1) {
    throw new Error("gallery registry schemaVersion must be 1");
  }
  if (!Array.isArray(value.apps) || value.apps.length > REGISTRY_MAX_APPS) {
    throw new Error(`gallery registry apps must contain at most ${REGISTRY_MAX_APPS} entries`);
  }
  const ids = new Set<string>();
  const apps = value.apps.map((entry, index): WorkspaceGalleryApp => {
    if (!isRecord(entry)) {
      throw new Error(`gallery registry apps[${index}] must be an object`);
    }
    assertKnownKeys(entry, ["id", "title", "description", "bundleUrl"], `apps[${index}]`);
    const id = requiredString(entry, "id", `apps[${index}]`, 64);
    if (!APP_ID_PATTERN.test(id) || ids.has(id)) {
      throw new Error(`apps[${index}].id is invalid or duplicated`);
    }
    ids.add(id);
    const title = requiredString(entry, "title", `apps[${index}]`, 80);
    const description = entry.description;
    if (
      description !== undefined &&
      (typeof description !== "string" || description.length > 500)
    ) {
      throw new Error(`apps[${index}].description must be at most 500 characters`);
    }
    const bundleUrl = validateAllowedUrl(
      entry.bundleUrl,
      allowedOrigins,
      `apps[${index}].bundleUrl`,
    ).href;
    return { id, title, ...(description ? { description } : {}), bundleUrl };
  });
  return { schemaVersion: 1, apps };
}

export async function fetchWorkspaceGallery(
  url: string,
  options: GalleryNetworkOptions,
): Promise<WorkspaceGalleryRegistry> {
  if (options.allowedOrigins.length === 0) {
    throw new Error("workspace gallery is disabled; configure gallery.allowedOrigins");
  }
  return validateRegistry(
    await fetchGalleryJson(url, REGISTRY_MAX_BYTES, options),
    options.allowedOrigins,
  );
}

type NormalizedBundle = { name: string; manifest: WidgetManifest; files: Map<string, string> };

function validateBundle(value: unknown): NormalizedBundle {
  if (!isRecord(value)) {
    throw new Error("widget bundle must be an object");
  }
  assertKnownKeys(value, ["schemaVersion", "name", "manifest", "files"], "widget bundle");
  if (value.schemaVersion !== 1) {
    throw new Error("widget bundle schemaVersion must be 1");
  }
  const name = typeof value.name === "string" ? value.name : "";
  if (!CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    throw new Error("widget bundle name is invalid");
  }
  if (!isRecord(value.manifest)) {
    throw new Error("widget bundle manifest must be an object");
  }
  const manifestBytes = Buffer.byteLength(JSON.stringify(value.manifest), "utf8");
  if (manifestBytes > MANIFEST_MAX_BYTES) {
    throw new Error("widget bundle manifest exceeds 32768 bytes");
  }
  const manifest = validateWidgetManifest(value.manifest, name);
  if (!isRecord(value.files)) {
    throw new Error("widget bundle files must be an object");
  }
  const entries = Object.entries(value.files);
  if (entries.length < 1 || entries.length > BUNDLE_MAX_FILES) {
    throw new Error(`widget bundle files must contain 1-${BUNDLE_MAX_FILES} entries`);
  }
  const files = new Map<string, string>();
  let totalBytes = 0;
  for (const [rawPath, content] of entries) {
    if (typeof content !== "string") {
      throw new Error(`widget bundle file content must be text: ${rawPath}`);
    }
    let logicalPath: string;
    try {
      logicalPath = normalizeWorkspaceDataLogicalPath(rawPath);
    } catch {
      throw new Error(`widget bundle file path is invalid: ${rawPath}`);
    }
    const extension = path.posix.extname(logicalPath).toLowerCase();
    if (!TEXT_WIDGET_EXTENSIONS.has(extension) || !(extension in WIDGET_CONTENT_TYPES)) {
      throw new Error(`widget bundle file type is not allowed: ${logicalPath}`);
    }
    if (files.has(logicalPath) || logicalPath === "widget.json") {
      throw new Error(`widget bundle file path is duplicated or reserved: ${logicalPath}`);
    }
    totalBytes += Buffer.byteLength(content, "utf8");
    if (totalBytes > BUNDLE_MAX_BYTES) {
      throw new Error(`widget bundle files exceed ${BUNDLE_MAX_BYTES} bytes`);
    }
    files.set(logicalPath, content);
  }
  if (!files.has(manifest.entrypoint)) {
    throw new Error("widget bundle is missing its entrypoint file");
  }
  return { name, manifest, files };
}

async function installBundle(
  bundle: NormalizedBundle,
  options: Pick<InstallGalleryOptions, "actor" | "stateDir" | "store">,
): Promise<WorkspaceWidgetRegistryEntry> {
  const stateDir = path.resolve(options.stateDir ?? resolveStateDir());
  const widgetDir = resolveWidgetDir(bundle.name, stateDir);
  await fs.mkdir(path.dirname(widgetDir), { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(widgetDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`workspace widget already exists: ${bundle.name}`, { cause: error });
    }
    throw error;
  }
  try {
    const files = new Map(bundle.files);
    files.set("widget.json", `${JSON.stringify(bundle.manifest, null, 2)}\n`);
    for (const [logicalPath, content] of files) {
      const target = path.resolve(widgetDir, logicalPath);
      if (!target.startsWith(`${widgetDir}${path.sep}`)) {
        throw new Error(`widget bundle file escapes its directory: ${logicalPath}`);
      }
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await replaceFileAtomic({
        filePath: target,
        content,
        mode: 0o600,
        tempPrefix: ".workspace-gallery-install",
        throwOnCleanupError: true,
      });
    }
    const result = await options.store.mutate(
      (draft) => {
        if (draft.widgetsRegistry[bundle.name]) {
          throw new Error(`workspace widget already exists: ${bundle.name}`);
        }
        draft.widgetsRegistry[bundle.name] = { status: "pending", createdBy: options.actor };
      },
      { actor: options.actor },
    );
    return result.doc.widgetsRegistry[bundle.name]!;
  } catch (error) {
    await fs.rm(widgetDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function installWorkspaceGalleryWidget(
  bundleUrl: string,
  options: InstallGalleryOptions,
): Promise<{ name: string; registry: WorkspaceWidgetRegistryEntry }> {
  if (options.allowedOrigins.length === 0) {
    throw new Error("workspace gallery is disabled; configure gallery.allowedOrigins");
  }
  const bundle = validateBundle(await fetchGalleryJson(bundleUrl, BUNDLE_MAX_BYTES, options));
  const registry = await installBundle(bundle, options);
  return { name: bundle.name, registry };
}

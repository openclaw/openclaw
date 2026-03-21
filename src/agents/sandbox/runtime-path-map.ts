import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { splitSandboxBindSpec } from "./bind-spec.js";
import type { SandboxDockerConfig } from "./types.js";

const CONTAINER_NATIVE_ROOTS = [
  "/home/node/.openclaw",
  "/shared-workspace",
  "/shared-files",
  "/agent-homes",
];

type RuntimePathMapEntry = {
  container: string;
  host: string;
};

type RuntimePathMapDocument = {
  container_host_roots?: RuntimePathMapEntry[];
};

let cachedRuntimePathMap: RuntimePathMapEntry[] | null | undefined;
let cachedRuntimePathMapSource: string | null | undefined;

function normalizeAbsolutePosix(value: string): string {
  return path.posix.normalize(value.trim()) || "/";
}

function hasPathPrefix(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function resolveHostPath(host: string, filePath?: string): string {
  if (path.posix.isAbsolute(host)) {
    return normalizeAbsolutePosix(host);
  }
  if (!filePath) {
    return normalizeAbsolutePosix(host);
  }
  const baseRoot = path.posix.dirname(path.posix.dirname(filePath));
  return normalizeAbsolutePosix(path.posix.join(baseRoot, host));
}

export function isContainerNativePath(rawPath: string): boolean {
  if (!path.posix.isAbsolute(rawPath)) {
    return false;
  }
  const normalized = normalizeAbsolutePosix(rawPath);
  return CONTAINER_NATIVE_ROOTS.some((root) => hasPathPrefix(normalized, root));
}

function loadRuntimePathMapEntriesFromDocument(
  document: RuntimePathMapDocument,
  filePath?: string,
): RuntimePathMapEntry[] {
  const entries = Array.isArray(document.container_host_roots) ? document.container_host_roots : [];
  return entries
    .filter((entry): entry is RuntimePathMapEntry =>
      Boolean(entry && typeof entry.container === "string" && typeof entry.host === "string"),
    )
    .map((entry) => ({
      container: normalizeAbsolutePosix(entry.container),
      host: resolveHostPath(entry.host, filePath),
    }))
    .filter((entry) => path.posix.isAbsolute(entry.container) && path.posix.isAbsolute(entry.host))
    .toSorted((left, right) => right.container.length - left.container.length);
}

export function loadRuntimePathMapEntries(
  filePath: string | undefined = process.env.OPENCLAW_LOCAL_PATH_MAP?.trim() ||
    path.join(resolveStateDir(process.env), "config", "runtime-path-map.json"),
): RuntimePathMapEntry[] {
  const normalizedFilePath = filePath?.trim() || undefined;
  const cacheKey = normalizedFilePath ?? null;
  if (
    cachedRuntimePathMap !== undefined &&
    cachedRuntimePathMapSource !== undefined &&
    cachedRuntimePathMapSource === cacheKey
  ) {
    return cachedRuntimePathMap ?? [];
  }
  if (!normalizedFilePath) {
    cachedRuntimePathMap = null;
    cachedRuntimePathMapSource = cacheKey;
    return [];
  }
  try {
    const raw = fs.readFileSync(normalizedFilePath, "utf-8");
    cachedRuntimePathMap = loadRuntimePathMapEntriesFromDocument(
      JSON.parse(raw) as RuntimePathMapDocument,
      normalizedFilePath,
    );
  } catch {
    cachedRuntimePathMap = null;
  }
  cachedRuntimePathMapSource = cacheKey;
  return cachedRuntimePathMap ?? [];
}

export function translateContainerPathToHostPath(
  rawPath: string,
  entries: RuntimePathMapEntry[] = loadRuntimePathMapEntries(),
): string {
  if (!path.posix.isAbsolute(rawPath)) {
    return rawPath;
  }
  const normalized = normalizeAbsolutePosix(rawPath);
  for (const entry of entries) {
    if (!hasPathPrefix(normalized, entry.container)) {
      continue;
    }
    const suffix = normalized.slice(entry.container.length);
    return suffix ? `${entry.host}${suffix}` : entry.host;
  }
  return normalized;
}

export function isRuntimePathMapped(
  rawPath: string,
  entries: RuntimePathMapEntry[] = loadRuntimePathMapEntries(),
): boolean {
  if (!path.posix.isAbsolute(rawPath)) {
    return false;
  }
  const normalized = normalizeAbsolutePosix(rawPath);
  if (!isContainerNativePath(normalized)) {
    return true;
  }
  return translateContainerPathToHostPath(normalized, entries) !== normalized;
}

export function translateSandboxBindSpecToHostPath(
  bindSpec: string,
  entries: RuntimePathMapEntry[] = loadRuntimePathMapEntries(),
): string {
  const parsed = splitSandboxBindSpec(bindSpec);
  if (!parsed) {
    return bindSpec;
  }
  const translatedHost = translateContainerPathToHostPath(parsed.host, entries);
  return parsed.options
    ? `${translatedHost}:${parsed.container}:${parsed.options}`
    : `${translatedHost}:${parsed.container}`;
}

export function collectTranslatedSandboxBindSourceRoots(
  bindSpecs: string[] | undefined,
  entries: RuntimePathMapEntry[] = loadRuntimePathMapEntries(),
): string[] {
  if (!bindSpecs?.length) {
    return [];
  }
  const roots = new Set<string>();
  for (const bindSpec of bindSpecs) {
    const parsed = splitSandboxBindSpec(bindSpec);
    if (!parsed) {
      continue;
    }
    const source = normalizeAbsolutePosix(parsed.host);
    if (!path.posix.isAbsolute(source)) {
      continue;
    }
    const translated = translateContainerPathToHostPath(source, entries);
    if (translated !== source) {
      roots.add(translated);
    }
  }
  return [...roots];
}

export function translateSandboxDockerConfigToHost(
  docker: SandboxDockerConfig,
  entries: RuntimePathMapEntry[] = loadRuntimePathMapEntries(),
): SandboxDockerConfig {
  if (!docker.binds?.length && !docker.allowedSourceRoots?.length) {
    return docker;
  }
  return {
    ...docker,
    binds: docker.binds?.map((bind) => translateSandboxBindSpecToHostPath(bind, entries)),
    allowedSourceRoots: docker.allowedSourceRoots?.map((root) =>
      translateContainerPathToHostPath(root, entries),
    ),
  };
}

export function __resetRuntimePathMapCacheForTests(): void {
  cachedRuntimePathMap = undefined;
  cachedRuntimePathMapSource = undefined;
}

export function __loadRuntimePathMapEntriesFromDocumentForTests(
  document: RuntimePathMapDocument,
  filePath = "/Users/test/.openclaw/config/runtime-path-map.json",
): RuntimePathMapEntry[] {
  return loadRuntimePathMapEntriesFromDocument(document, filePath);
}

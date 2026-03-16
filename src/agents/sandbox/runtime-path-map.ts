import fs from "node:fs";
import path from "node:path";
import { splitSandboxBindSpec } from "./bind-spec.js";
import type { SandboxDockerConfig } from "./types.js";

type RuntimePathMapEntry = {
  container: string;
  host: string;
};

type RuntimePathMapDocument = {
  container_host_roots?: RuntimePathMapEntry[];
};

const DEFAULT_RUNTIME_PATH_MAP = "/shared-workspace/config/openclaw/local/path-map.json";

let cachedRuntimePathMap: RuntimePathMapEntry[] | null | undefined;

function normalizeAbsolutePosix(value: string): string {
  return path.posix.normalize(value.trim()) || "/";
}

function hasPathPrefix(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function loadRuntimePathMapEntriesFromDocument(
  document: RuntimePathMapDocument,
): RuntimePathMapEntry[] {
  const entries = Array.isArray(document.container_host_roots) ? document.container_host_roots : [];
  return entries
    .filter((entry): entry is RuntimePathMapEntry =>
      Boolean(entry && typeof entry.container === "string" && typeof entry.host === "string"),
    )
    .map((entry) => ({
      container: normalizeAbsolutePosix(entry.container),
      host: normalizeAbsolutePosix(entry.host),
    }))
    .filter((entry) => path.posix.isAbsolute(entry.container) && path.posix.isAbsolute(entry.host))
    .toSorted((left, right) => right.container.length - left.container.length);
}

export function loadRuntimePathMapEntries(
  filePath: string = process.env.OPENCLAW_LOCAL_PATH_MAP?.trim() || DEFAULT_RUNTIME_PATH_MAP,
): RuntimePathMapEntry[] {
  if (cachedRuntimePathMap !== undefined) {
    return cachedRuntimePathMap ?? [];
  }
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    cachedRuntimePathMap = loadRuntimePathMapEntriesFromDocument(
      JSON.parse(raw) as RuntimePathMapDocument,
    );
  } catch {
    cachedRuntimePathMap = null;
  }
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
}

export function __loadRuntimePathMapEntriesFromDocumentForTests(
  document: RuntimePathMapDocument,
): RuntimePathMapEntry[] {
  return loadRuntimePathMapEntriesFromDocument(document);
}

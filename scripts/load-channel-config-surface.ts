import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type BuiltChannelConfigSurface = {
  schema: Record<string, unknown>;
  uiHints?: Record<string, unknown>;
};

type JsonSchemaCapableSurface = {
  toJSONSchema?: (params?: Record<string, unknown>) => unknown;
  uiHints?: Record<string, unknown>;
};

function isBuiltChannelConfigSchema(value: unknown): value is BuiltChannelConfigSurface {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as { schema?: unknown };
  return Boolean(candidate.schema && typeof candidate.schema === "object");
}

function buildSchemaSurface(value: unknown): BuiltChannelConfigSurface | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as JsonSchemaCapableSurface;
  if (typeof candidate.toJSONSchema === "function") {
    return {
      schema: candidate.toJSONSchema({
        target: "draft-07",
        unrepresentable: "any",
      }) as Record<string, unknown>,
      ...(candidate.uiHints ? { uiHints: candidate.uiHints } : {}),
    };
  }
  return {
    schema: {
      type: "object",
      additionalProperties: true,
    },
    ...(candidate.uiHints ? { uiHints: candidate.uiHints } : {}),
  };
}

function resolveChannelConfigSurfaceExport(
  imported: Record<string, unknown>,
): BuiltChannelConfigSurface | null {
  for (const [name, value] of Object.entries(imported)) {
    if (name.endsWith("ChannelConfigSchema") && isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  for (const [name, value] of Object.entries(imported)) {
    if (!name.endsWith("ConfigSchema") || name.endsWith("AccountConfigSchema")) {
      continue;
    }
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
    const wrapped = buildSchemaSurface(value);
    if (wrapped) {
      return wrapped;
    }
  }

  for (const value of Object.values(imported)) {
    if (isBuiltChannelConfigSchema(value)) {
      return value;
    }
  }

  return null;
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function resolvePackageRoot(modulePath: string): string {
  let cursor = path.dirname(path.resolve(modulePath));
  while (true) {
    if (fs.existsSync(path.join(cursor, "package.json"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      throw new Error(`package root not found for ${modulePath}`);
    }
    cursor = parent;
  }
}

function shouldRetryViaIsolatedCopy(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const code = "code" in error ? error.code : undefined;
  return code === "ERR_MODULE_NOT_FOUND";
}

const SOURCE_FILE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function resolveImportCandidates(basePath: string): string[] {
  const extension = path.extname(basePath);
  const candidates = new Set<string>([basePath]);
  if (extension) {
    const stem = basePath.slice(0, -extension.length);
    for (const sourceExtension of SOURCE_FILE_EXTENSIONS) {
      candidates.add(`${stem}${sourceExtension}`);
    }
  } else {
    for (const sourceExtension of SOURCE_FILE_EXTENSIONS) {
      candidates.add(`${basePath}${sourceExtension}`);
      candidates.add(path.join(basePath, `index${sourceExtension}`));
    }
  }
  return Array.from(candidates);
}

function resolveRelativeImportPath(fromFile: string, specifier: string): string | null {
  for (const candidate of resolveImportCandidates(
    path.resolve(path.dirname(fromFile), specifier),
  )) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function collectRelativeImportGraph(entryPath: string): Set<string> {
  const discovered = new Set<string>();
  const queue = [path.resolve(entryPath)];
  const importPattern =
    /(?:import|export)\s+(?:[^"'`]*?\s+from\s+)?["'`]([^"'`]+)["'`]|import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;

  while (queue.length > 0) {
    const currentPath = queue.pop();
    if (!currentPath || discovered.has(currentPath)) {
      continue;
    }
    discovered.add(currentPath);

    const source = fs.readFileSync(currentPath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2];
      if (!specifier?.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelativeImportPath(currentPath, specifier);
      if (resolved) {
        queue.push(resolved);
      }
    }
  }

  return discovered;
}

function resolveCommonAncestor(paths: Iterable<string>): string {
  const resolvedPaths = Array.from(paths, (entry) => path.resolve(entry));
  const [first, ...rest] = resolvedPaths;
  if (!first) {
    throw new Error("cannot resolve common ancestor for empty path set");
  }
  let ancestor = first;
  for (const candidate of rest) {
    while (path.relative(ancestor, candidate).startsWith(`..${path.sep}`)) {
      const parent = path.dirname(ancestor);
      if (parent === ancestor) {
        return ancestor;
      }
      ancestor = parent;
    }
  }
  return ancestor;
}

function copyModuleImportGraphWithoutNodeModules(params: {
  modulePath: string;
  repoRoot: string;
}): {
  copiedModulePath: string;
  cleanup: () => void;
} {
  const packageRoot = resolvePackageRoot(params.modulePath);
  const relativeFiles = collectRelativeImportGraph(params.modulePath);
  const copyRoot = resolveCommonAncestor([packageRoot, ...relativeFiles]);
  const relativeModulePath = path.relative(copyRoot, params.modulePath);
  const tempParent = path.join(params.repoRoot, ".openclaw-config-doc-cache");
  fs.mkdirSync(tempParent, { recursive: true });
  const isolatedRoot = fs.mkdtempSync(path.join(tempParent, `${path.basename(packageRoot)}-`));

  for (const sourcePath of relativeFiles) {
    const relativePath = path.relative(copyRoot, sourcePath);
    const targetPath = path.join(isolatedRoot, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
  }
  return {
    copiedModulePath: path.join(isolatedRoot, relativeModulePath),
    cleanup: () => {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    },
  };
}

export async function loadChannelConfigSurfaceModule(
  modulePath: string,
  options?: { repoRoot?: string },
): Promise<{ schema: Record<string, unknown>; uiHints?: Record<string, unknown> } | null> {
  const repoRoot = options?.repoRoot ?? resolveRepoRoot();

  try {
    const imported = (await import(pathToFileURL(modulePath).href)) as Record<string, unknown>;
    return resolveChannelConfigSurfaceExport(imported);
  } catch (error) {
    if (!shouldRetryViaIsolatedCopy(error)) {
      throw error;
    }

    const isolatedCopy = copyModuleImportGraphWithoutNodeModules({ modulePath, repoRoot });
    try {
      const imported = (await import(
        `${pathToFileURL(isolatedCopy.copiedModulePath).href}?isolated=${Date.now()}`
      )) as Record<string, unknown>;
      return resolveChannelConfigSurfaceExport(imported);
    } finally {
      isolatedCopy.cleanup();
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const modulePath = process.argv[2]?.trim();
  if (!modulePath) {
    process.exit(2);
  }

  const resolved = await loadChannelConfigSurfaceModule(modulePath);
  if (!resolved) {
    process.exit(3);
  }

  process.stdout.write(JSON.stringify(resolved));
  process.exit(0);
}

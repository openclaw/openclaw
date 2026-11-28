import fs from "node:fs";
import path from "node:path";
import { BUNDLED_PLUGIN_PATH_PREFIX } from "../bundled-plugin-paths.mjs";
import { publicPluginSdkEntrypoints } from "../plugin-sdk-entries.mts";
import type { PublicEntrypoint, TopologyScope, UsageBucket } from "./types.js";

function isTestFile(relPath: string): boolean {
  return (
    relPath.startsWith("test/") ||
    relPath.includes("/__tests__/") ||
    relPath.includes(".test.") ||
    relPath.includes(".spec.") ||
    relPath.includes(".e2e.") ||
    relPath.includes(".suite.") ||
    relPath.includes("test-harness") ||
    relPath.includes("test-support") ||
    relPath.includes("test-helper") ||
    relPath.includes("test-utils")
  );
}

export function classifyUsageBucket(scope: TopologyScope, relPath: string): UsageBucket {
  if (scope.internalRoots.some((root) => relPath === root || relPath.startsWith(`${root}/`))) {
    return "internal";
  }
  return isTestFile(relPath) ? "test" : "production";
}

export function consumerOwner(relPath: string): string | null {
  const [root, name] = relPath.split("/");
  for (const [prefix, owner] of [
    [BUNDLED_PLUGIN_PATH_PREFIX, "extension"],
    ["packages/", "package"],
    ["apps/", "app"],
  ] as const) {
    if (relPath.startsWith(prefix)) {
      return name ? `${owner}:${name}` : owner;
    }
  }
  return relPath.startsWith("test/") ? null : root || "other";
}

function buildScopeFromEntrypoints(
  id: string,
  description: string,
  entrypoints: PublicEntrypoint[],
): TopologyScope {
  return {
    id,
    description,
    entrypoints,
    internalRoots: [
      ...new Set(entrypoints.map((entrypoint) => path.posix.dirname(entrypoint.sourcePath))),
    ],
  };
}

export function createPluginSdkScope(_repoRoot: string): TopologyScope {
  const entrypoints = publicPluginSdkEntrypoints.map((entrypoint) => ({
    entrypoint,
    sourcePath: `src/plugin-sdk/${entrypoint}.ts`,
    importSpecifier: `openclaw/plugin-sdk/${entrypoint}`,
  }));
  return buildScopeFromEntrypoints("plugin-sdk", "OpenClaw plugin-sdk public surface", entrypoints);
}

export function createFilesystemPublicSurfaceScope(
  repoRoot: string,
  options: {
    id: string;
    description?: string;
    entrypointRoot: string;
    importPrefix: string;
  },
): TopologyScope {
  const absoluteRoot = path.join(repoRoot, options.entrypointRoot);
  const entries = fs
    .readdirSync(absoluteRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .toSorted();
  const publicEntrypoints = entries.map((fileName) => {
    const entrypoint = fileName.replace(/\.ts$/, "");
    return {
      entrypoint,
      sourcePath: path.posix.join(options.entrypointRoot, fileName),
      importSpecifier:
        entrypoint === "index" ? options.importPrefix : `${options.importPrefix}/${entrypoint}`,
    };
  });
  return buildScopeFromEntrypoints(
    options.id,
    options.description ?? `Public surface rooted at ${options.entrypointRoot}`,
    publicEntrypoints,
  );
}

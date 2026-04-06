import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizePluginsConfigWithResolver,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "../../plugins/config-policy.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRegistry,
} from "../../plugins/manifest-registry.js";
import { hasKind } from "../../plugins/slots.js";
import { isPathInsideWithRealpath } from "../../security/scan-paths.js";

const log = createSubsystemLogger("skills");

function buildRegistryPluginIdAliases(
  registry: PluginManifestRegistry,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    registry.plugins
      .flatMap((record) => [
        ...record.providers
          .filter((providerId) => providerId !== record.id)
          .map((providerId) => [providerId, record.id] as const),
        ...(record.legacyPluginIds ?? []).map(
          (legacyPluginId) => [legacyPluginId, record.id] as const,
        ),
      ])
      .toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function createRegistryPluginIdNormalizer(
  registry: PluginManifestRegistry,
): (id: string) => string {
  const aliases = buildRegistryPluginIdAliases(registry);
  return (id: string) => {
    const trimmed = id.trim();
    return aliases[trimmed] ?? trimmed;
  };
}

interface BundledRuntimeRemap {
  remapped: string;
  /** The built plugin root (e.g. <pkg>/dist/extensions/<id>) that the remapped path must stay inside. */
  builtPluginRoot: string | null;
  /** The package root that contains both dist-runtime/ and dist/ trees. */
  packageRoot: string | null;
}

type ResolvedPluginSkillDir = {
  loadDir: string;
  watchDir: string;
};

/**
 * On Windows a bare drive letter like "C:" is CWD-relative; ensure it
 * becomes "C:\" so path.join produces absolute paths.
 * @internal Exported for testing only.
 */
export function normalizeDriveRoot(raw: string, sep: string): string {
  return raw.length === 2 && raw[1] === ":" ? raw + sep : raw;
}

function maybeResolveBundledRuntimeSkillDir(
  candidate: string,
  rootDir: string,
): BundledRuntimeRemap {
  const normalized = path.normalize(candidate);
  // Segment-aware marker: leading sep ensures we don't match partial dir names
  // like "mydist-runtime".
  const segmentMarker = path.sep + path.join("dist-runtime", "extensions") + path.sep;
  const markerIndex = normalized.indexOf(segmentMarker);
  if (markerIndex === -1) {
    return { remapped: candidate, builtPluginRoot: null, packageRoot: null };
  }

  // packageRoot is everything before the sep that starts segmentMarker.
  const packageRoot = normalizeDriveRoot(normalized.slice(0, markerIndex), path.sep);
  const bundledLeaf = normalized.slice(markerIndex + segmentMarker.length);

  // Verify the plugin rootDir itself is under the same dist-runtime/extensions subtree.
  // Without this, a non-bundled plugin whose path accidentally contains the marker
  // segment would be incorrectly remapped outside its configured root.
  const runtimeSubtree = path.join(packageRoot, "dist-runtime", "extensions");
  const normalizedRootDir = path.normalize(rootDir);
  if (
    !normalizedRootDir.startsWith(runtimeSubtree + path.sep) &&
    normalizedRootDir !== runtimeSubtree
  ) {
    return { remapped: candidate, builtPluginRoot: null, packageRoot: null };
  }
  if (!packageRoot || !bundledLeaf) {
    return { remapped: candidate, builtPluginRoot: null, packageRoot: null };
  }

  const builtCandidate = path.join(packageRoot, "dist", "extensions", bundledLeaf);
  if (!fs.existsSync(builtCandidate)) {
    return { remapped: candidate, builtPluginRoot: null, packageRoot: null };
  }

  // Derive the built plugin root from the plugin id (first path segment of bundledLeaf).
  const pluginId = bundledLeaf.split(path.sep)[0]!;
  const builtPluginRoot = path.join(packageRoot, "dist", "extensions", pluginId);
  return { remapped: builtCandidate, builtPluginRoot, packageRoot };
}

function resolvePluginSkillDirEntries(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): ResolvedPluginSkillDir[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    return [];
  }
  const registry = loadPluginManifestRegistry({
    workspaceDir,
    config: params.config,
  });
  if (registry.plugins.length === 0) {
    return [];
  }
  const normalizedPlugins = normalizePluginsConfigWithResolver(
    params.config?.plugins,
    createRegistryPluginIdNormalizer(registry),
  );
  const acpEnabled = params.config?.acp?.enabled !== false;
  const memorySlot = normalizedPlugins.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const seenLoadDirs = new Set<string>();
  const resolvedEntries: ResolvedPluginSkillDir[] = [];

  for (const record of registry.plugins) {
    if (!record.skills || record.skills.length === 0) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.config,
    });
    if (!activationState.activated) {
      continue;
    }
    // ACP router skills should not be attached when ACP is explicitly disabled.
    if (!acpEnabled && record.id === "acpx") {
      continue;
    }
    const memoryDecision = resolveMemorySlotDecision({
      id: record.id,
      kind: record.kind,
      slot: memorySlot,
      selectedId: selectedMemoryPluginId,
    });
    if (!memoryDecision.enabled) {
      continue;
    }
    if (memoryDecision.selected && hasKind(record.kind, "memory")) {
      selectedMemoryPluginId = record.id;
    }
    for (const raw of record.skills) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(record.rootDir, trimmed);
      if (!fs.existsSync(candidate)) {
        log.warn(`plugin skill path not found (${record.id}): ${candidate}`);
        continue;
      }
      if (!isPathInsideWithRealpath(record.rootDir, candidate, { requireRealpath: true })) {
        log.warn(`plugin skill path escapes plugin root (${record.id}): ${candidate}`);
        continue;
      }
      if (seenLoadDirs.has(candidate)) {
        continue;
      }
      const { remapped, builtPluginRoot, packageRoot } = maybeResolveBundledRuntimeSkillDir(
        candidate,
        record.rootDir,
      );
      const preferredCandidate = path.resolve(remapped);
      if (builtPluginRoot != null && packageRoot != null && preferredCandidate !== candidate) {
        // Verify the built plugin root itself is anchored inside the package root.
        // Without this, a symlinked dist/extensions/<id> escapes the package boundary.
        if (!isPathInsideWithRealpath(packageRoot, builtPluginRoot, { requireRealpath: true })) {
          log.warn(`built plugin root escapes package boundary (${record.id}): ${builtPluginRoot}`);
          continue;
        }
        // Verify the remapped path stays inside the built plugin root (prevents sibling escape).
        if (
          !isPathInsideWithRealpath(builtPluginRoot, preferredCandidate, { requireRealpath: true })
        ) {
          log.warn(
            `remapped plugin skill path escapes built plugin root (${record.id}): ${preferredCandidate}`,
          );
          continue;
        }
      }
      if (seenLoadDirs.has(preferredCandidate)) {
        continue;
      }
      seenLoadDirs.add(preferredCandidate);
      resolvedEntries.push({
        loadDir: preferredCandidate,
        // Keep watching the original validated root so local dist-runtime overlays
        // are not dropped by the watcher ignore rule for /dist/.
        watchDir: candidate,
      });
    }
  }

  return resolvedEntries;
}

export function resolvePluginSkillDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): string[] {
  return resolvePluginSkillDirEntries(params).map((entry) => entry.loadDir);
}

export function resolvePluginSkillWatchDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): string[] {
  return resolvePluginSkillDirEntries(params).map((entry) => entry.watchDir);
}

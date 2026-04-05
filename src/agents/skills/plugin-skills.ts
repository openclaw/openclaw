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
}

function maybeResolveBundledRuntimeSkillDir(candidate: string): BundledRuntimeRemap {
  const normalized = path.normalize(candidate);
  const runtimeMarker = path.join("dist-runtime", "extensions") + path.sep;
  const markerIndex = normalized.lastIndexOf(runtimeMarker);
  if (markerIndex === -1) {
    return { remapped: candidate, builtPluginRoot: null };
  }

  const packageRoot = normalized.slice(0, markerIndex);
  const bundledLeaf = normalized.slice(markerIndex + runtimeMarker.length);
  if (!packageRoot || !bundledLeaf) {
    return { remapped: candidate, builtPluginRoot: null };
  }

  const builtCandidate = path.join(packageRoot, "dist", "extensions", bundledLeaf);
  if (!fs.existsSync(builtCandidate)) {
    return { remapped: candidate, builtPluginRoot: null };
  }

  // Derive the built plugin root from the plugin id (first path segment of bundledLeaf).
  const pluginId = bundledLeaf.split(path.sep)[0]!;
  const builtPluginRoot = path.join(packageRoot, "dist", "extensions", pluginId);
  return { remapped: builtCandidate, builtPluginRoot };
}

export function resolvePluginSkillDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): string[] {
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
  const seen = new Set<string>();
  const resolved: string[] = [];

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
      if (seen.has(candidate)) {
        continue;
      }
      const { remapped, builtPluginRoot } = maybeResolveBundledRuntimeSkillDir(candidate);
      const preferredCandidate = path.resolve(remapped);
      if (builtPluginRoot != null && preferredCandidate !== candidate) {
        // Re-validate the remapped path against the built plugin root to prevent
        // symlink-based escapes (including to sibling plugins within the same package).
        if (
          !isPathInsideWithRealpath(builtPluginRoot, preferredCandidate, { requireRealpath: true })
        ) {
          log.warn(
            `remapped plugin skill path escapes built plugin root (${record.id}): ${preferredCandidate}`,
          );
          continue;
        }
      }
      if (seen.has(preferredCandidate)) {
        continue;
      }
      seen.add(preferredCandidate);
      resolved.push(preferredCandidate);
    }
  }

  return resolved;
}

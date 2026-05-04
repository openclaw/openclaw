import fs from "node:fs";
import path from "node:path";
import { isAcpRuntimeSpawnAvailable } from "../../acp/runtime/availability.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizePluginsConfigWithResolver,
  resolveEffectivePluginActivationState,
  resolveMemorySlotDecision,
} from "../../plugins/config-policy.js";
import { loadPluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { hasKind } from "../../plugins/slots.js";
import { isPathInsideWithRealpath } from "../../security/scan-paths.js";
import { CONFIG_DIR } from "../../utils.js";

const log = createSubsystemLogger("skills");

export function resolvePluginSkillDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
  /** Override the managed skills directory for testing. */
  managedSkillsDir?: string;
}): string[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    return [];
  }
  const metadataSnapshot = loadPluginMetadataSnapshot({
    workspaceDir,
    config: params.config ?? {},
    env: process.env,
  });
  const registry = metadataSnapshot.manifestRegistry;
  if (registry.plugins.length === 0) {
    return [];
  }
  const normalizedPlugins = normalizePluginsConfigWithResolver(
    params.config?.plugins,
    metadataSnapshot.normalizePluginId,
  );
  const acpRuntimeAvailable = isAcpRuntimeSpawnAvailable({ config: params.config });
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
      enabledByDefault: record.enabledByDefault,
    });
    if (!activationState.activated) {
      continue;
    }
    // ACP router skills should not be attached unless ACP can actually spawn.
    if (!acpRuntimeAvailable && record.id === "acpx") {
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
      seen.add(candidate);
      resolved.push(candidate);
    }
  }

  publishPluginSkillsToManagedSkillsDir(resolved, {
    managedSkillsDir: params.managedSkillsDir,
  });

  return resolved;
}

function resolveDefaultManagedSkillsDir(): string {
  return path.join(CONFIG_DIR, "skills");
}

/**
 * Collect skill dir targets from a resolved directory.
 * If the directory contains a direct SKILL.md it is published as-is.
 * Otherwise child subdirectories that contain SKILL.md are expanded.
 */
function collectSkillTargets(dir: string, targets: Map<string, string>): void {
  if (fs.existsSync(path.join(dir, "SKILL.md"))) {
    const basename = path.basename(dir);
    const existing = targets.get(basename);
    if (existing) {
      log.warn(
        `plugin skill name collision: "${basename}" resolves to both ${existing} and ${dir}; ` +
          `only the first will be published to managed skills`,
      );
      return;
    }
    targets.set(basename, dir);
    return;
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childPath = path.join(dir, entry.name);
    if (!fs.existsSync(path.join(childPath, "SKILL.md"))) continue;
    const basename = entry.name;
    const existing = targets.get(basename);
    if (existing) {
      log.warn(
        `plugin skill name collision: "${basename}" resolves to both ${existing} and ${childPath}; ` +
          `only the first will be published to managed skills`,
      );
      continue;
    }
    targets.set(basename, childPath);
  }
}

/**
 * Creates symlinks from each resolved plugin skill directory into the
 * managed skills directory (~/.openclaw/skills/) so the agent SDK can
 * discover them at the conventional file-system path.
 */
function publishPluginSkillsToManagedSkillsDir(
  skillDirs: string[],
  opts?: { managedSkillsDir?: string },
): void {
  const managedSkillsDir = opts?.managedSkillsDir ?? resolveDefaultManagedSkillsDir();
  const managedTargets = new Map<string, string>();

  // Collect basename → target mappings, reporting collisions.
  // Directories that contain SKILL.md are published as-is.
  // Parent containers (e.g. ./skills/) are expanded to their child
  // directories that each contain a SKILL.md.
  for (const dir of skillDirs) {
    collectSkillTargets(dir, managedTargets);
  }

  // Create symlinks — but never replace an existing managed entry.
  // Managed skills outrank plugin extra dirs.
  for (const [name, target] of managedTargets) {
    const linkPath = path.join(managedSkillsDir, name);
    try {
      fs.mkdirSync(managedSkillsDir, { recursive: true });
    } catch {
      // best-effort; symlink will fail below if dir is truly unusable
    }
    try {
      const existingTarget = fs.readlinkSync(linkPath);
      if (existingTarget === target) {
        continue;
      }
      log.warn(
        `managed skill symlink "${linkPath}" already exists, skipping plugin skill "${target}"`,
      );
      continue;
    } catch (err) {
      if (!isNotFoundError(err)) {
        log.warn(`failed to inspect managed skill symlink "${linkPath}": ${String(err)}`);
        continue;
      }
    }
    try {
      fs.symlinkSync(target, linkPath, "dir");
    } catch (err) {
      log.warn(
        `failed to create managed skill symlink "${linkPath}" → "${target}": ${String(err)}`,
      );
    }
  }

  // Clean up stale symlinks for plugin skills that are no longer active.
  let managedEntries: fs.Dirent[];
  try {
    managedEntries = fs.readdirSync(managedSkillsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of managedEntries) {
    if (!entry.isSymbolicLink()) {
      continue;
    }
    if (managedTargets.has(entry.name)) {
      continue;
    }
    const linkPath = path.join(managedSkillsDir, entry.name);
    try {
      const target = fs.readlinkSync(linkPath);
      // Only remove symlinks that point to directories that no longer exist.
      if (!fs.existsSync(target)) {
        fs.unlinkSync(linkPath);
      }
    } catch {
      // Broken symlink or other issue — best-effort cleanup.
      try {
        fs.unlinkSync(linkPath);
      } catch {
        // ignore
      }
    }
  }
}

function isNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as Record<string, unknown>).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export const __testing = {
  publishPluginSkillsToManagedSkillsDir,
};

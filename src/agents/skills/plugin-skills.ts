import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/config.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizePluginsConfig,
  resolveEnableState,
  resolveMemorySlotDecision,
} from "../../plugins/config-state.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../../plugins/manifest-registry.js";

const log = createSubsystemLogger("skills");

export function resolvePluginSkillDirs(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
}): string[] {
  const workspaceDir = params.workspaceDir.trim();
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
  const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
  const memorySlot = normalizedPlugins.slots.memory;
  let selectedMemoryPluginId: string | null = null;
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const record of registry.plugins) {
    if (!record.skills || record.skills.length === 0) {
      continue;
    }
    const enableState = resolveEnableState(record.id, record.origin, normalizedPlugins);
    if (!enableState.enabled) {
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
    if (memoryDecision.selected && record.kind === "memory") {
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
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      resolved.push(candidate);
    }
  }

  return resolved;
}

/**
 * Resolve enabled plugin records from the manifest registry.
 *
 * Shared filter logic used by command/agent/hook directory resolvers
 * to avoid duplicating plugin enablement checks.
 */
function resolveEnabledPluginRecords(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
}): PluginManifestRecord[] {
  const workspaceDir = params.workspaceDir.trim();
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
  const normalizedPlugins = normalizePluginsConfig(params.config?.plugins);
  const enabled: PluginManifestRecord[] = [];

  for (const record of registry.plugins) {
    const enableState = resolveEnableState(record.id, record.origin, normalizedPlugins);
    if (!enableState.enabled) {
      continue;
    }
    enabled.push(record);
  }

  return enabled;
}

/**
 * Resolve absolute paths to plugin command directories.
 *
 * Only returns directories that exist on disk and belong to enabled plugins.
 */
export function resolvePluginCommandDirs(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
}): string[] {
  const records = resolveEnabledPluginRecords(params);
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const record of records) {
    if (!record.commands) {
      continue;
    }
    const candidate = path.resolve(record.rootDir, record.commands);
    if (!fs.existsSync(candidate)) {
      log.warn(`plugin commands path not found (${record.id}): ${candidate}`);
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    resolved.push(candidate);
  }

  return resolved;
}

/**
 * Resolve absolute paths to plugin agent definition directories.
 *
 * Only returns directories that exist on disk and belong to enabled plugins.
 */
export function resolvePluginAgentDirs(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
}): string[] {
  const records = resolveEnabledPluginRecords(params);
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const record of records) {
    if (!record.agents) {
      continue;
    }
    const candidate = path.resolve(record.rootDir, record.agents);
    if (!fs.existsSync(candidate)) {
      log.warn(`plugin agents path not found (${record.id}): ${candidate}`);
      continue;
    }
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    resolved.push(candidate);
  }

  return resolved;
}

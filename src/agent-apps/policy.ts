import type { AppRegistryEntry } from "@aotui/runtime";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/config.js";

function normalizeRegistryName(name: string): string {
  return name.trim();
}

export function isAotuiEnabled(cfg?: OpenClawConfig): boolean {
  return cfg?.aotui?.enabled !== false;
}

export function resolveAotuiRegistryEntries(cfg?: OpenClawConfig): AppRegistryEntry[] {
  const entries = cfg?.aotui?.apps;
  if (!entries) {
    return [];
  }

  return Object.entries(entries)
    .filter(
      ([name, entry]) => normalizeRegistryName(name).length > 0 && Boolean(entry?.source?.trim()),
    )
    .map(([name, entry]) => ({
      name: normalizeRegistryName(name),
      source: entry.source.trim(),
      ...(entry.version?.trim() ? { version: entry.version.trim() } : {}),
      enabled: entry.enabled !== false,
      ...(entry.workerScript?.trim() ? { workerScript: entry.workerScript.trim() } : {}),
      ...(entry.description?.trim() ? { description: entry.description.trim() } : {}),
      ...(entry.whatItIs?.trim() ? { whatItIs: entry.whatItIs.trim() } : {}),
      ...(entry.whenToUse?.trim() ? { whenToUse: entry.whenToUse.trim() } : {}),
      ...(entry.promptRole ? { promptRole: entry.promptRole } : {}),
    }));
}

export function resolveAotuiAgentAppNames(
  cfg: OpenClawConfig | undefined,
  agentId: string,
): string[] {
  const agentConfig = cfg ? resolveAgentConfig(cfg, agentId) : undefined;
  const configuredNames =
    agentConfig?.aotui?.apps !== undefined
      ? agentConfig.aotui.apps
      : cfg?.agents?.defaults?.aotui?.apps;

  if (!configuredNames) {
    return [];
  }

  const seen = new Set<string>();
  const names: string[] = [];
  for (const rawName of configuredNames) {
    const name = normalizeRegistryName(rawName);
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    names.push(name);
  }
  return names;
}

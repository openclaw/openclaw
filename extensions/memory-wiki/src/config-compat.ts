// Memory Wiki helper module supports config compat behavior.
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "../api.js";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasLegacyPluginConfig(value: unknown): boolean {
  return Object.keys(asRecord(value) ?? {}).length > 0;
}

export const legacyConfigRules: LegacyConfigRule[] = [
  {
    path: ["plugins", "entries", "memory-wiki", "config"],
    message:
      'plugins.entries.memory-wiki.config is legacy; use memory.extensions.memory-wiki. Run "openclaw doctor --fix".',
    match: hasLegacyPluginConfig,
  },
];

function mergeMissing(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existing = asRecord(target[key]);
    const nested = asRecord(value);
    if (existing && nested) {
      mergeMissing(existing, nested);
      continue;
    }
    if (!Object.hasOwn(target, key)) {
      target[key] = value;
    }
  }
}

function resolveMemoryWikiExtensionConfig(
  config: OpenClawConfig,
  agentId?: string,
): Record<string, unknown> | null {
  const agents = asRecord(config.agents);
  const source = agentId
    ? Array.isArray(agents?.list)
      ? agents.list.find((entry) => {
          const candidate = asRecord(entry);
          return typeof candidate?.id === "string" && normalizeAgentId(candidate.id) === agentId;
        })
      : undefined
    : config;
  const memory = agentId ? asRecord(asRecord(source)?.memory) : asRecord(config.memory);
  const extensions = asRecord(memory?.extensions);
  return asRecord(extensions?.["memory-wiki"]);
}

function hasExplicitVaultPath(config: Record<string, unknown> | null): boolean {
  return typeof asRecord(config?.vault)?.path === "string";
}

function ensureMemoryWikiExtensionConfig(
  config: OpenClawConfig,
  agentId?: string,
): Record<string, unknown> {
  const agents = asRecord(config.agents) ?? {};
  const target = agentId
    ? Array.isArray(agents.list)
      ? agents.list.find((entry) => {
          const candidate = asRecord(entry);
          return typeof candidate?.id === "string" && normalizeAgentId(candidate.id) === agentId;
        })
      : undefined
    : undefined;
  if (agentId && !target) {
    throw new Error(`Cannot migrate Memory Wiki config: missing agent "${agentId}".`);
  }
  if (agentId) {
    config.agents = agents;
  }
  const container = agentId ? asRecord(target) : config;
  const memory = asRecord(container?.memory) ?? {};
  if (container) {
    container.memory = memory;
  }
  const extensions = asRecord(memory.extensions) ?? {};
  memory.extensions = extensions;
  const wikiConfig = asRecord(extensions["memory-wiki"]) ?? {};
  extensions["memory-wiki"] = wikiConfig;
  return wikiConfig;
}

function shouldPreserveLegacyDefaultVault(
  config: OpenClawConfig,
  options: { homedir?: string; pathExists?: (path: string) => boolean } | undefined,
): boolean {
  const defaultAgentId = resolveDefaultAgentId(config);
  if (
    defaultAgentId === "main" ||
    hasExplicitVaultPath(resolveMemoryWikiExtensionConfig(config)) ||
    hasExplicitVaultPath(resolveMemoryWikiExtensionConfig(config, defaultAgentId))
  ) {
    return false;
  }
  const homedir = options?.homedir ?? os.homedir();
  const pathExists = options?.pathExists ?? existsSync;
  const legacyVaultPath = path.join(homedir, ".openclaw", "wiki", "main");
  const agentVaultPath = path.join(homedir, ".openclaw", "wiki", defaultAgentId);
  return pathExists(legacyVaultPath) && !pathExists(agentVaultPath);
}

export function migrateMemoryWikiLegacyConfig(
  config: OpenClawConfig,
  options?: { homedir?: string; pathExists?: (path: string) => boolean },
): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const rawEntry = asRecord(config.plugins?.entries?.["memory-wiki"]);
  const rawPluginConfig = asRecord(rawEntry?.config);
  const preserveLegacyDefaultVault =
    !hasExplicitVaultPath(rawPluginConfig) && shouldPreserveLegacyDefaultVault(config, options);
  if (!rawPluginConfig && !preserveLegacyDefaultVault) {
    return null;
  }

  const nextConfig = structuredClone(config);
  const changes: string[] = [];

  let wikiConfig: Record<string, unknown> | undefined;

  if (rawPluginConfig) {
    const hasCanonicalConfig = resolveMemoryWikiExtensionConfig(nextConfig) !== null;
    wikiConfig = ensureMemoryWikiExtensionConfig(nextConfig);
    const nextPlugins = asRecord(nextConfig.plugins) ?? {};
    nextConfig.plugins = nextPlugins;
    const nextEntries = asRecord(nextPlugins.entries) ?? {};
    nextPlugins.entries = nextEntries;
    const nextEntry = asRecord(nextEntries["memory-wiki"]) ?? {};
    nextEntries["memory-wiki"] = nextEntry;
    const nextPluginConfig = asRecord(nextEntry.config) ?? {};
    nextEntry.config = nextPluginConfig;
    const nextBridge = asRecord(nextPluginConfig.bridge) ?? {};
    if (Object.keys(nextBridge).length > 0) {
      nextPluginConfig.bridge = nextBridge;
    }

    const legacyValue = nextBridge.readMemoryCore;
    const hasCanonical = Object.hasOwn(nextBridge, "readMemoryArtifacts");
    if (!hasCanonical && legacyValue !== undefined) {
      nextBridge.readMemoryArtifacts = legacyValue;
    }
    if (legacyValue !== undefined) {
      delete nextBridge.readMemoryCore;
      changes.push(
        hasCanonical
          ? "Removed legacy plugins.entries.memory-wiki.config.bridge.readMemoryCore; kept explicit bridge.readMemoryArtifacts."
          : "Moved plugins.entries.memory-wiki.config.bridge.readMemoryCore → bridge.readMemoryArtifacts.",
      );
    }

    if (hasCanonicalConfig) {
      mergeMissing(wikiConfig, nextPluginConfig);
      changes.push(
        "Merged plugins.entries.memory-wiki.config → memory.extensions.memory-wiki (kept explicit memory settings).",
      );
    } else {
      Object.assign(wikiConfig, nextPluginConfig);
      changes.push(
        "Moved plugins.entries.memory-wiki.config → memory.extensions.memory-wiki.",
      );
    }
    delete nextEntry.config;
  }

  if (preserveLegacyDefaultVault) {
    const defaultAgentId = resolveDefaultAgentId(nextConfig);
    const resolvedWikiConfig = ensureMemoryWikiExtensionConfig(nextConfig, defaultAgentId);
    const vault = asRecord(resolvedWikiConfig.vault) ?? {};
    resolvedWikiConfig.vault = vault;
    vault.path = "~/.openclaw/wiki/main";
    changes.push("Preserved legacy ~/.openclaw/wiki/main as the default agent Memory Wiki vault.");
  }

  return {
    config: nextConfig,
    changes,
  };
}

export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  return migrateMemoryWikiLegacyConfig(cfg) ?? { config: cfg, changes: [] };
}

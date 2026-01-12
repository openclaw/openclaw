import fs from "node:fs/promises";
import path from "node:path";

import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import { resolveClawdbotAgentDir } from "./agent-paths.js";

type ModelsConfig = NonNullable<ClawdbotConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeGoogleModelId(id: string): string {
  if (id === "gemini-3-pro") return "gemini-3-pro-preview";
  if (id === "gemini-3-flash") return "gemini-3-flash-preview";
  return id;
}

function normalizeGoogleProvider(provider: ProviderConfig): ProviderConfig {
  let mutated = false;
  const models = provider.models.map((model) => {
    const nextId = normalizeGoogleModelId(model.id);
    if (nextId === model.id) return model;
    mutated = true;
    return { ...model, id: nextId };
  });
  return mutated ? { ...provider, models } : provider;
}

function normalizeProviders(
  providers: ModelsConfig["providers"],
): ModelsConfig["providers"] {
  if (!providers) return providers;
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    const normalized =
      key === "google" ? normalizeGoogleProvider(provider) : provider;
    if (normalized !== provider) mutated = true;
    next[key] = normalized;
  }
  return mutated ? next : providers;
}

async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export async function ensureClawdbotModelsJson(
  config?: ClawdbotConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();
  const providers = cfg.models?.providers;
  if (!providers || Object.keys(providers).length === 0) {
    const agentDir = agentDirOverride?.trim()
      ? agentDirOverride.trim()
      : resolveClawdbotAgentDir();
    return { agentDir, wrote: false };
  }

  const mode = cfg.models?.mode ?? DEFAULT_MODE;
  const agentDir = agentDirOverride?.trim()
    ? agentDirOverride.trim()
    : resolveClawdbotAgentDir();
  const targetPath = path.join(agentDir, "models.json");

  let mergedProviders = providers;
  let existingRaw = "";
  if (mode === "merge") {
    const existing = await readJson(targetPath);
    if (isRecord(existing) && isRecord(existing.providers)) {
      const existingProviders = existing.providers as Record<
        string,
        NonNullable<ModelsConfig["providers"]>[string]
      >;
      mergedProviders = { ...existingProviders, ...providers };
    }
  }

  const normalizedProviders = normalizeProviders(mergedProviders);
  const next = `${JSON.stringify({ providers: normalizedProviders }, null, 2)}\n`;
  try {
    existingRaw = await fs.readFile(targetPath, "utf8");
  } catch {
    existingRaw = "";
  }

  if (existingRaw === next) {
    return { agentDir, wrote: false };
  }

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(targetPath, next, { mode: 0o600 });
  return { agentDir, wrote: true };
}

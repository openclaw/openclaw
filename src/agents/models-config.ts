import fs from "node:fs/promises";
import path from "node:path";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { isRecord } from "../utils.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import {
  normalizeProviders,
  type ProviderConfig,
  resolveImplicitBedrockProvider,
  resolveImplicitCopilotProvider,
  resolveImplicitProviders,
} from "./models-config.providers.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;

const DEFAULT_MODE: NonNullable<ModelsConfig["mode"]> = "merge";

function resolvePreferredTokenLimit(explicitValue: number, implicitValue: number): number {
  // Keep catalog refresh behavior for stale low values while preserving
  // intentional larger user overrides (for example Ollama >128k contexts).
  return explicitValue > implicitValue ? explicitValue : implicitValue;
}

function mergeProviderModels(implicit: ProviderConfig, explicit: ProviderConfig): ProviderConfig {
  const implicitModels = Array.isArray(implicit.models) ? implicit.models : [];
  const explicitModels = Array.isArray(explicit.models) ? explicit.models : [];
  if (implicitModels.length === 0) {
    return { ...implicit, ...explicit };
  }

  const getId = (model: unknown): string => {
    if (!model || typeof model !== "object") {
      return "";
    }
    const id = (model as { id?: unknown }).id;
    return typeof id === "string" ? id.trim() : "";
  };
  const implicitById = new Map(
    implicitModels.map((model) => [getId(model), model] as const).filter(([id]) => Boolean(id)),
  );
  const seen = new Set<string>();

  const mergedModels = explicitModels.map((explicitModel) => {
    const id = getId(explicitModel);
    if (!id) {
      return explicitModel;
    }
    seen.add(id);
    const implicitModel = implicitById.get(id);
    if (!implicitModel) {
      return explicitModel;
    }

    // Refresh capability metadata from the implicit catalog while preserving
    // user-specific fields (cost, headers, compat, etc.) on explicit entries.
    // reasoning is treated as user-overridable: if the user has explicitly set
    // it in their config (key present), honour that value; otherwise fall back
    // to the built-in catalog default so new reasoning models work out of the
    // box without requiring every user to configure it.
    return {
      ...explicitModel,
      input: implicitModel.input,
      reasoning: "reasoning" in explicitModel ? explicitModel.reasoning : implicitModel.reasoning,
      contextWindow: resolvePreferredTokenLimit(
        explicitModel.contextWindow,
        implicitModel.contextWindow,
      ),
      maxTokens: resolvePreferredTokenLimit(explicitModel.maxTokens, implicitModel.maxTokens),
    };
  });

  for (const implicitModel of implicitModels) {
    const id = getId(implicitModel);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    mergedModels.push(implicitModel);
  }

  return {
    ...implicit,
    ...explicit,
    models: mergedModels,
  };
}

function mergeProviders(params: {
  implicit?: Record<string, ProviderConfig> | null;
  explicit?: Record<string, ProviderConfig> | null;
}): Record<string, ProviderConfig> {
  const out: Record<string, ProviderConfig> = params.implicit ? { ...params.implicit } : {};
  for (const [key, explicit] of Object.entries(params.explicit ?? {})) {
    const providerKey = key.trim();
    if (!providerKey) {
      continue;
    }
    const implicit = out[providerKey];
    out[providerKey] = implicit ? mergeProviderModels(implicit, explicit) : explicit;
  }
  return out;
}

async function readJson(pathname: string): Promise<unknown> {
  try {
    const raw = await fs.readFile(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * ENV_VAR_NAME_RE matches strings that look like environment variable names
 * (e.g. "OPENAI_API_KEY"). These are safe to persist in models.json because
 * they are *references*, not the secret value itself.
 */
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{1,127}$/;

/**
 * Strip resolved secret values from provider entries before writing to disk.
 * Keeps env var *names* (which are safe references) but removes anything that
 * looks like a resolved API key or token.
 */
function redactApiKeysForPersistence(
  providers: ModelsConfig["providers"],
): ModelsConfig["providers"] {
  if (!providers) {
    return providers;
  }
  const redacted: Record<string, ProviderConfig> = {};
  for (const [key, entry] of Object.entries(providers)) {
    if (!entry) {
      redacted[key] = entry;
      continue;
    }
    const apiKey = (entry as Record<string, unknown>).apiKey;
    if (typeof apiKey === "string" && apiKey.trim() && !ENV_VAR_NAME_RE.test(apiKey.trim())) {
      // This apiKey is a resolved secret (not an env var name) — replace with
      // a placeholder so that ModelRegistry still sees an apiKey field (required
      // for provider registration) while the actual value stays out of disk.
      redacted[key] = { ...entry, apiKey: "REDACTED" } as ProviderConfig;
    } else {
      redacted[key] = entry;
    }
  }
  return redacted;
}

export async function ensureOpenClawModelsJson(
  config?: OpenClawConfig,
  agentDirOverride?: string,
): Promise<{ agentDir: string; wrote: boolean }> {
  const cfg = config ?? loadConfig();
  const agentDir = agentDirOverride?.trim() ? agentDirOverride.trim() : resolveOpenClawAgentDir();

  const explicitProviders = cfg.models?.providers ?? {};
  const implicitProviders = await resolveImplicitProviders({ agentDir, explicitProviders });
  const providers: Record<string, ProviderConfig> = mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
  const implicitBedrock = await resolveImplicitBedrockProvider({ agentDir, config: cfg });
  if (implicitBedrock) {
    const existing = providers["amazon-bedrock"];
    providers["amazon-bedrock"] = existing
      ? mergeProviderModels(implicitBedrock, existing)
      : implicitBedrock;
  }
  const implicitCopilot = await resolveImplicitCopilotProvider({ agentDir });
  if (implicitCopilot && !providers["github-copilot"]) {
    providers["github-copilot"] = implicitCopilot;
  }

  if (Object.keys(providers).length === 0) {
    return { agentDir, wrote: false };
  }

  const mode = cfg.models?.mode ?? DEFAULT_MODE;
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
      mergedProviders = {};
      for (const [key, entry] of Object.entries(existingProviders)) {
        mergedProviders[key] = entry;
      }
      for (const [key, newEntry] of Object.entries(providers)) {
        const existing = existingProviders[key] as
          | (NonNullable<ModelsConfig["providers"]>[string] & {
              apiKey?: string;
              baseUrl?: string;
            })
          | undefined;
        if (existing) {
          const preserved: Record<string, unknown> = {};
          if (typeof existing.apiKey === "string" && existing.apiKey) {
            preserved.apiKey = existing.apiKey;
          }
          if (typeof existing.baseUrl === "string" && existing.baseUrl) {
            preserved.baseUrl = existing.baseUrl;
          }
          mergedProviders[key] = { ...newEntry, ...preserved };
        } else {
          mergedProviders[key] = newEntry;
        }
      }
    }
  }

  const normalizedProviders = normalizeProviders({
    providers: mergedProviders,
    agentDir,
  });

  // Security: strip resolved API keys from the persisted models.json.
  // SecretRef values and environment variables are resolved to plaintext during
  // normalization, but writing them to disk defeats at-rest secret protection.
  // The runtime auth chain (profiles → env → config) can re-resolve keys on
  // demand, so models.json only needs env var *names* (not values).
  const redactedProviders = redactApiKeysForPersistence(normalizedProviders);
  const next = `${JSON.stringify({ providers: redactedProviders }, null, 2)}\n`;
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

// Google API module exposes the plugin public contract.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";
import { asNullableRecord as asRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type LegacyConfigRule = {
  path: Array<string | number>;
  message: string;
  match: (value: unknown) => boolean;
};

export const legacyConfigRules: LegacyConfigRule[] = [];

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Normalize legacy Google provider config to satisfy the current catalog schema.
 *
 * Older Google provider blocks may lack `api`, include unsupported input modalities
 * (audio, video), and miss `cost.cacheWrite`. This backfills those fields so the
 * provider stays available instead of being silently dropped by catalog validation.
 *
 * See: https://github.com/openclaw/openclaw/issues/102138
 */
export function normalizeCompatibilityConfig({ cfg }: { cfg: OpenClawConfig }): {
  config: OpenClawConfig;
  changes: string[];
} {
  const changes: string[] = [];
  const rawModels = asRecord(cfg.models);
  if (!rawModels) {
    return { config: cfg, changes };
  }
  const rawProviders = asRecord(rawModels.providers);
  if (!rawProviders) {
    return { config: cfg, changes };
  }
  const rawGoogle = asRecord(rawProviders.google);
  if (!rawGoogle) {
    return { config: cfg, changes };
  }

  const nextConfig = structuredClone(cfg);
  const nextModels = asRecord(nextConfig.models) ?? {};
  nextConfig.models = nextModels as OpenClawConfig["models"];
  const nextProviders = asRecord(nextModels.providers) ?? {};
  nextModels.providers = nextProviders;
  const nextGoogle = asRecord(nextProviders.google) ?? {};
  nextProviders.google = nextGoogle;

  // Backfill api if missing.
  if (!isString(nextGoogle.api) || !nextGoogle.api.trim()) {
    nextGoogle.api = "google-generative-ai";
    changes.push("Set models.providers.google.api = google-generative-ai (was missing).");
  }

  // Coerce model input modalities and cost.cacheWrite.
  const models = nextGoogle.models;
  if (Array.isArray(models)) {
    const nextModelsArr = models.map((model, index) => {
      const m = asRecord(model);
      if (!m) {
        return model;
      }
      const nextModel = { ...m } as Record<string, unknown>;

      // Coerce input to ["text", "image"] (remove audio, video).
      if (Array.isArray(nextModel.input)) {
        const filtered = (nextModel.input as string[]).filter(
          (v: string) => v === "text" || v === "image",
        );
        if (filtered.length !== (nextModel.input as string[]).length) {
          nextModel.input = filtered;
          changes.push(
            `Coerced models.providers.google.models[${index}].input to [text, image] (removed unsupported modalities).`,
          );
        }
      }

      // Backfill cost.cacheWrite.
      const cost = asRecord(nextModel.cost);
      if (cost && (!("cacheWrite" in cost) || typeof cost.cacheWrite !== "number")) {
        cost.cacheWrite = 0;
        changes.push(
          `Added models.providers.google.models[${index}].cost.cacheWrite = 0 (was missing).`,
        );
      }

      return nextModel;
    });

    if (nextModelsArr.some((m, i) => m !== models[i])) {
      nextGoogle.models = nextModelsArr;
    }
  }

  if (!changes.length) {
    return { config: cfg, changes };
  }

  return { config: nextConfig, changes };
}

export const sessionRouteStateOwners: DoctorSessionRouteStateOwner[] = [
  {
    id: "google",
    label: "Google",
    providerIds: ["google", "google-antigravity", "google-gemini-cli", "google-vertex"],
    runtimeIds: ["google-gemini-cli"],
    cliSessionKeys: ["google-gemini-cli", "gemini-cli"],
    authProfilePrefixes: [
      "google:",
      "google-antigravity:",
      "google-gemini-cli:",
      "google-vertex:",
      "gemini-cli:",
    ],
  },
];

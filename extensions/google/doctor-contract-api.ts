// Google API module exposes the plugin public contract.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DoctorSessionRouteStateOwner } from "openclaw/plugin-sdk/runtime-doctor";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type LegacyConfigRule = {
  path: string[];
  message: string;
  match: (value: unknown) => boolean;
};

export const legacyConfigRules: LegacyConfigRule[] = [];

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
  const rawModels = cfg.models;
  if (!isRecord(rawModels)) {
    return { config: cfg, changes };
  }
  const rawProviders = rawModels.providers;
  if (!isRecord(rawProviders)) {
    return { config: cfg, changes };
  }
  const rawGoogle = rawProviders.google;
  if (!isRecord(rawGoogle)) {
    return { config: cfg, changes };
  }

  let googleChanged = false;
  const nextGoogle = { ...rawGoogle } as Record<string, unknown>;

  // Backfill api if missing.
  if (typeof nextGoogle.api !== "string" || !nextGoogle.api.trim()) {
    nextGoogle.api = "google-generative-ai";
    googleChanged = true;
    changes.push("Set models.providers.google.api = google-generative-ai (was missing).");
  }

  // Coerce model input modalities and cost.cacheWrite.
  if (Array.isArray(nextGoogle.models)) {
    const nextGoogleModels = nextGoogle.models.map((model, index) => {
      if (!isRecord(model)) {
        return model;
      }
      let modelChanged = false;
      const nextModel = { ...model } as Record<string, unknown>;

      // Coerce input to ["text", "image"] (remove audio, video).
      if (Array.isArray(nextModel.input)) {
        const filtered = (nextModel.input as string[]).filter(
          (m: string) => m === "text" || m === "image",
        );
        if (filtered.length !== (nextModel.input as string[]).length) {
          nextModel.input = filtered;
          modelChanged = true;
          changes.push(
            `Coerced models.providers.google.models[${index}].input to [text, image] (removed unsupported modalities).`,
          );
        }
      }

      // Backfill cost.cacheWrite.
      if (isRecord(nextModel.cost)) {
        const cost = { ...nextModel.cost } as Record<string, unknown>;
        if (!("cacheWrite" in cost) || typeof cost.cacheWrite !== "number") {
          cost.cacheWrite = 0;
          modelChanged = true;
          changes.push(
            `Added models.providers.google.models[${index}].cost.cacheWrite = 0 (was missing).`,
          );
        }
        if (modelChanged) {
          nextModel.cost = cost;
        }
      }

      return modelChanged ? nextModel : model;
    });

    if (nextGoogleModels.some((m, i) => m !== nextGoogle.models[i])) {
      nextGoogle.models = nextGoogleModels;
      googleChanged = true;
    }
  }

  if (!googleChanged) {
    return { config: cfg, changes };
  }

  return {
    config: {
      ...cfg,
      models: {
        ...rawModels,
        providers: {
          ...rawProviders,
          google: nextGoogle,
        },
      },
    } as OpenClawConfig,
    changes,
  };
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

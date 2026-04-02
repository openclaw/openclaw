import { OPENCODE_ZEN_DEFAULT_MODEL_REF } from "./onboard.js";
export {
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  OPENCODE_ZEN_DEFAULT_MODEL_REF,
} from "./onboard.js";

const LEGACY_OPENCODE_ZEN_DEFAULT_MODELS = new Set([
  "opencode/claude-opus-4-5",
  "opencode-zen/claude-opus-4-5",
]);

export const OPENCODE_ZEN_DEFAULT_MODEL = OPENCODE_ZEN_DEFAULT_MODEL_REF;

function resolveCurrentPrimaryModel(model: unknown): string | undefined {
  if (typeof model === "string") {
    return model.trim() || undefined;
  }
  if (
    model &&
    typeof model === "object" &&
    typeof (model as { primary?: unknown }).primary === "string"
  ) {
    return ((model as { primary: string }).primary || "").trim() || undefined;
  }
  return undefined;
}

export function applyOpencodeZenModelDefault(
  cfg: import("openclaw/plugin-sdk/provider-onboard").OpenClawConfig,
): {
  next: import("openclaw/plugin-sdk/provider-onboard").OpenClawConfig;
  changed: boolean;
} {
  const current = resolveCurrentPrimaryModel(cfg.agents?.defaults?.model);
  const normalizedCurrent =
    current && LEGACY_OPENCODE_ZEN_DEFAULT_MODELS.has(current)
      ? OPENCODE_ZEN_DEFAULT_MODEL
      : current;
  if (normalizedCurrent === OPENCODE_ZEN_DEFAULT_MODEL) {
    return { next: cfg, changed: false };
  }
  return {
    next: {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          model:
            cfg.agents?.defaults?.model && typeof cfg.agents.defaults.model === "object"
              ? {
                  ...cfg.agents.defaults.model,
                  primary: OPENCODE_ZEN_DEFAULT_MODEL,
                }
              : { primary: OPENCODE_ZEN_DEFAULT_MODEL },
        },
      },
    },
    changed: true,
  };
}

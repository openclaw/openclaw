import { OPENCODE_GO_DEFAULT_MODEL_REF } from "./onboard.js";

export {
  applyOpencodeGoConfig,
  applyOpencodeGoProviderConfig,
  OPENCODE_GO_DEFAULT_MODEL_REF,
} from "./onboard.js";

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

export function applyOpencodeGoModelDefault(
  cfg: import("openclaw/plugin-sdk/provider-onboard").OpenClawConfig,
): {
  next: import("openclaw/plugin-sdk/provider-onboard").OpenClawConfig;
  changed: boolean;
} {
  const current = resolveCurrentPrimaryModel(cfg.agents?.defaults?.model);
  if (current === OPENCODE_GO_DEFAULT_MODEL_REF) {
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
                  primary: OPENCODE_GO_DEFAULT_MODEL_REF,
                }
              : { primary: OPENCODE_GO_DEFAULT_MODEL_REF },
        },
      },
    },
    changed: true,
  };
}

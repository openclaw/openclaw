import {
  applyAgentDefaultModelPrimary,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";

export const PUTER_DEFAULT_MODEL = "puter/gemini-3.1-pro-preview";

export function applyPuterModelDefault(cfg: OpenClawConfig): {
  next: OpenClawConfig;
  changed: boolean;
} {
  const current = cfg.agents?.defaults?.model as unknown;
  const currentPrimary =
    typeof current === "string"
      ? current.trim() || undefined
      : current &&
          typeof current === "object" &&
          typeof (current as { primary?: unknown }).primary === "string"
        ? ((current as { primary: string }).primary || "").trim() || undefined
        : undefined;

  if (currentPrimary === PUTER_DEFAULT_MODEL) {
    return { next: cfg, changed: false };
  }

  return {
    next: applyAgentDefaultModelPrimary(cfg, PUTER_DEFAULT_MODEL),
    changed: true,
  };
}

import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/text-runtime";

// Mirror of the COPILOT_XHIGH_MODEL_IDS list maintained in `./index.ts`. Keep
// these two lists in sync; this surface is consulted via the bundled provider
// public artifact path when the active plugin registry has not registered the
// github-copilot plugin entry yet (e.g. dashboard `sessions.list` /
// `getSessionDefaults` calls). Without this artifact, callers fall through to
// the stock thinking profile and xhigh disappears from the dashboard.
const COPILOT_XHIGH_MODEL_IDS = [
  "gpt-5.4",
  "gpt-5.3-codex",
  "gpt-5.2",
  "gpt-5.2-codex",
  "claude-opus-4.7-1m-internal",
] as const;

export function resolveThinkingProfile(params: { provider: string; modelId: string }) {
  if (params.provider.trim().toLowerCase() !== "github-copilot") {
    return null;
  }
  const normalizedModelId = normalizeOptionalLowercaseString(params.modelId) ?? "";
  return {
    levels: [
      { id: "off" as const },
      { id: "minimal" as const },
      { id: "low" as const },
      { id: "medium" as const },
      { id: "high" as const },
      ...(COPILOT_XHIGH_MODEL_IDS.includes(normalizedModelId as never)
        ? [{ id: "xhigh" as const }]
        : []),
    ],
  };
}

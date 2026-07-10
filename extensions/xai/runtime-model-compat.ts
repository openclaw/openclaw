// Xai plugin module implements runtime model compat behavior.
// Reasoning effort is configurable only for current flagship Grok models; encrypted reasoning
// include/replay is handled separately in stream.ts for every reasoning-capable xAI model.
import { applyXaiModelCompat } from "./model-compat.js";

type XaiRuntimeModelCompat = {
  compat?: unknown;
  id?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: XaiThinkingLevelMap;
};
type XaiThinkingLevelMap = Partial<
  Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
>;

const XAI_UNSUPPORTED_REASONING_EFFORTS = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_REASONING_EFFORTS = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_SUPPORTED_REASONING_EFFORTS = ["low", "medium", "high"] as const;

function normalizeXaiCompatModelId(id: unknown): string {
  return typeof id === "string" ? id.trim().toLowerCase() : "";
}

function supportsConfigurableXaiReasoningEffort(model: XaiRuntimeModelCompat): boolean {
  const id = normalizeXaiCompatModelId(model.id);
  const isConfigurableModel = ["grok-4.3", "grok-4.5"].some(
    (prefix) => id === prefix || id.startsWith(`${prefix}-`),
  );
  return model.reasoning === true && isConfigurableModel;
}

function resolveXaiReasoningEffortCompat(model: XaiRuntimeModelCompat): Record<string, unknown> {
  if (supportsConfigurableXaiReasoningEffort(model)) {
    return {
      supportsReasoningEffort: true,
      supportedReasoningEfforts: [...XAI_SUPPORTED_REASONING_EFFORTS],
    };
  }
  return { supportsReasoningEffort: false };
}

export function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(
  model: T,
): T & { compat: Record<string, unknown>; thinkingLevelMap: XaiThinkingLevelMap } {
  const withCompat = applyXaiModelCompat(model);
  const supportsReasoningEffort = supportsConfigurableXaiReasoningEffort(withCompat);
  const existingCompat =
    withCompat.compat && typeof withCompat.compat === "object"
      ? (withCompat.compat as Record<string, unknown>)
      : {};
  return {
    ...withCompat,
    compat: {
      ...existingCompat,
      ...resolveXaiReasoningEffortCompat(withCompat),
    },
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      ...(supportsReasoningEffort ? XAI_REASONING_EFFORTS : XAI_UNSUPPORTED_REASONING_EFFORTS),
    },
  };
}

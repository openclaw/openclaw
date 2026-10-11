// Listed reasoning efforts (compat.supportedReasoningEfforts, projected from the Grok
// subscription listing) decide effort support; model-ID rules cover rows without them.
// Encrypted reasoning include/replay is handled separately in stream.ts for every
// reasoning-capable xAI model.
import { applyXaiModelCompat } from "./model-compat.js";
import {
  normalizeXaiReasoningEfforts,
  resolveXaiIdReasoningEfforts,
  XAI_REASONING_EFFORTS,
  type XaiReasoningEffort,
} from "./model-id.js";
import { supportsXaiPromptCacheKey } from "./provider-routing.js";

type XaiRuntimeModelCompat = {
  api?: unknown;
  baseUrl?: unknown;
  compat?: unknown;
  id?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: XaiThinkingLevelMap;
};
type XaiThinkingLevelMap = Partial<
  Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>
>;

type XaiActiveReasoningEffort = Exclude<XaiReasoningEffort, "none">;

const XAI_UNSUPPORTED_REASONING_EFFORTS = {
  off: undefined,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

function readListedReasoningEfforts(compat: unknown): XaiReasoningEffort[] | undefined {
  const listed =
    compat && typeof compat === "object" && "supportedReasoningEfforts" in compat
      ? compat.supportedReasoningEfforts
      : undefined;
  const efforts = Array.isArray(listed) ? normalizeXaiReasoningEfforts(listed) : [];
  return efforts.length > 0 ? efforts : undefined;
}

// Each level sends its own effort when supported, else the nearest supported one (the
// weaker on a tie). Off sends "none" only when the model can turn reasoning off.
function buildReasoningEffortMap(efforts: readonly XaiReasoningEffort[]) {
  const active = efforts.filter((effort): effort is XaiActiveReasoningEffort => effort !== "none");
  const nearest = (level: XaiActiveReasoningEffort) => {
    const distance = (effort: XaiReasoningEffort) =>
      Math.abs(XAI_REASONING_EFFORTS.indexOf(effort) - XAI_REASONING_EFFORTS.indexOf(level));
    return active.reduce((best, effort) => (distance(effort) < distance(best) ? effort : best));
  };
  return {
    off: efforts.includes("none") ? "none" : null,
    minimal: nearest("minimal"),
    low: nearest("low"),
    medium: nearest("medium"),
    high: nearest("high"),
    xhigh: nearest("xhigh"),
  } satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;
}

export function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(
  model: T,
): T & { compat: Record<string, unknown>; thinkingLevelMap: XaiThinkingLevelMap } {
  const withCompat = applyXaiModelCompat(model);
  const id = typeof withCompat.id === "string" ? withCompat.id.trim().toLowerCase() : "";
  const efforts =
    withCompat.reasoning === true
      ? (readListedReasoningEfforts(withCompat.compat) ?? resolveXaiIdReasoningEfforts(id))
      : [];
  const supportsReasoningEffort = efforts.some((effort) => effort !== "none");
  const existingCompat =
    withCompat.compat && typeof withCompat.compat === "object"
      ? { ...(withCompat.compat as Record<string, unknown>) }
      : {};
  if (supportsXaiPromptCacheKey(withCompat)) {
    existingCompat.supportsPromptCacheKey ??= true;
    existingCompat.supportsLongCacheRetention ??= false;
  }
  return {
    ...withCompat,
    compat: {
      ...existingCompat,
      supportsReasoningEffort,
      ...(supportsReasoningEffort ? { supportedReasoningEfforts: efforts } : {}),
    },
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      ...(supportsReasoningEffort
        ? buildReasoningEffortMap(efforts)
        : XAI_UNSUPPORTED_REASONING_EFFORTS),
    },
  };
}

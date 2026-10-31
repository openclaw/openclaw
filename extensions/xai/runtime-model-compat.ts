// Listed reasoning efforts (compat.supportedReasoningEfforts, projected from the Grok
// subscription listing) decide effort support; model-ID rules cover rows without them.
// Encrypted reasoning include/replay is handled separately in stream.ts for every
// reasoning-capable xAI model.
import type { ProviderRuntimeModel } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelCompatConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { applyXaiModelCompat } from "./model-compat.js";
import {
  normalizeXaiReasoningEfforts,
  resolveXaiIdReasoningEfforts,
  XAI_REASONING_EFFORTS,
  type XaiReasoningEffort,
} from "./model-id.js";
import { supportsXaiPromptCacheKey } from "./provider-routing.js";

type XaiRuntimeModelCompat = Pick<ProviderRuntimeModel, "id" | "reasoning"> &
  Partial<Pick<ProviderRuntimeModel, "api" | "baseUrl" | "compat">> & {
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

function readListedReasoningEfforts(compat?: ModelCompatConfig): XaiReasoningEffort[] | undefined {
  const efforts = normalizeXaiReasoningEfforts(compat?.supportedReasoningEfforts ?? []);
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
): T & { compat: ModelCompatConfig; thinkingLevelMap: XaiThinkingLevelMap } {
  const withCompat = applyXaiModelCompat(model);
  const id = withCompat.id.trim().toLowerCase();
  const efforts = withCompat.reasoning
    ? (readListedReasoningEfforts(withCompat.compat) ?? resolveXaiIdReasoningEfforts(id))
    : [];
  const supportsReasoningEffort = efforts.some((effort) => effort !== "none");
  const compat = {
    ...withCompat.compat,
    supportsReasoningEffort,
    ...(supportsReasoningEffort ? { supportedReasoningEfforts: efforts } : {}),
  };
  if (supportsXaiPromptCacheKey(withCompat)) {
    compat.supportsPromptCacheKey ??= true;
    compat.supportsLongCacheRetention ??= false;
  }
  return {
    ...withCompat,
    compat,
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      ...(supportsReasoningEffort
        ? buildReasoningEffortMap(efforts)
        : XAI_UNSUPPORTED_REASONING_EFFORTS),
    },
  };
}

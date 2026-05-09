import { applyXaiModelCompat } from "openclaw/plugin-sdk/provider-tools";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

type XaiRuntimeModelCompat = {
  compat?: unknown;
  reasoning?: unknown;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
};

// Reasoning-capable Grok models accept these reasoning_effort values via the
// OpenAI-compatible Responses API. The "off" level intentionally maps to null
// so pi-ai skips emitting the reasoning parameter, matching xAI's contract
// where omitting reasoning disables it.
//
// xAI's API also documents an explicit "none" effort that disables reasoning,
// but pi-ai's openai-responses provider already short-circuits when no effort
// is set, so omission is the cleaner path and avoids spurious reasoning_effort
// strings on plain (non-thinking) calls.
//
// Non-reasoning xAI routes (and unknown/legacy models without `model.reasoning`)
// keep the prior off-only behavior to avoid sending reasoning_effort to routes
// that reject it. This was the live failure that motivated the original clamp;
// see CHANGELOG entry around the previous "clamp xAI thinking to off" change.
const XAI_REASONING_EFFORT_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

const XAI_NO_REASONING_EFFORT_MAP = {
  off: null,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
} satisfies NonNullable<XaiRuntimeModelCompat["thinkingLevelMap"]>;

export function applyXaiRuntimeModelCompat<T extends XaiRuntimeModelCompat>(model: T): T {
  const withCompat = applyXaiModelCompat(model);
  const isReasoningCapable = withCompat.reasoning === true;
  const reasoningEffortMap = isReasoningCapable
    ? XAI_REASONING_EFFORT_MAP
    : XAI_NO_REASONING_EFFORT_MAP;
  return {
    ...withCompat,
    thinkingLevelMap: {
      ...withCompat.thinkingLevelMap,
      ...reasoningEffortMap,
    },
  };
}

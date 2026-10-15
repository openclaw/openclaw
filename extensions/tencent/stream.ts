import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createPayloadPatchStreamWrapper,
  type OpenAICompatibleThinkingLevel,
} from "openclaw/plugin-sdk/provider-stream-shared";
import { TOKENHUB_PROVIDER_ID, TOKENPLAN_PROVIDER_ID } from "./models.js";

const TENCENT_PROVIDER_IDS: ReadonlySet<string> = new Set([
  TOKENHUB_PROVIDER_ID,
  TOKENPLAN_PROVIDER_ID,
]);

type StreamOptions = Parameters<StreamFn>[2];

// Only hy3 has a verified two-rung override. Other models retain shared effort handling.
const TENCENT_TWO_RUNG_EFFORT_MAP: Readonly<Record<string, string>> = Object.freeze({
  off: "none",
  none: "none",
  minimal: "high",
  low: "high",
  medium: "high",
  high: "high",
  xhigh: "high",
});

function resolveRequestedEffort(
  thinkingLevel: OpenAICompatibleThinkingLevel,
  options: StreamOptions,
): string | undefined {
  const withEffort = (options ?? {}) as { reasoningEffort?: unknown; reasoning?: unknown };
  const raw =
    (typeof withEffort.reasoningEffort === "string" && withEffort.reasoningEffort) ||
    (typeof withEffort.reasoning === "string" && withEffort.reasoning) ||
    (typeof thinkingLevel === "string" && thinkingLevel) ||
    undefined;
  return raw ? raw.trim().toLowerCase() : undefined;
}

export function wrapTencentProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  return createPayloadPatchStreamWrapper(
    ctx.streamFn,
    ({ payload, options }) => {
      const requested = resolveRequestedEffort(ctx.thinkingLevel, options);
      const mapped =
        requested && Object.hasOwn(TENCENT_TWO_RUNG_EFFORT_MAP, requested)
          ? TENCENT_TWO_RUNG_EFFORT_MAP[requested]
          : undefined;
      if (mapped !== undefined) {
        payload.reasoning_effort = mapped;
      }
    },
    {
      shouldPatch: ({ model }) =>
        TENCENT_PROVIDER_IDS.has(model.provider) &&
        model.api === "openai-completions" &&
        model.id === "hy3",
    },
  );
}

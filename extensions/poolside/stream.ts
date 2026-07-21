/**
 * Poolside request sampling and model-id policy.
 *
 * Poolside's Laguna endpoints accept only `temperature`. They ignore `top_p`,
 * `top_k`, `min_p`, and the penalties, and their no-parameter default
 * (temperature 1.0, untruncated) leaks control tokens and repeats. This wrapper
 * forces a safe default temperature when the caller sets none, and drops the
 * unsupported sampling fields so nothing surprising reaches the wire.
 *
 * The endpoint also expects the `poolside/`-prefixed model id on the wire (for
 * example `poolside/laguna-s-2.1`), while OpenClaw model refs stay
 * `poolside/laguna-s-2.1` with the bare `laguna-s-2.1` catalog id. The wrapper
 * restores the prefix so the model ref reads cleanly without a double prefix.
 */
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";

const POOLSIDE_PROVIDER_ID = "poolside";
const POOLSIDE_MODEL_ID_PREFIX = "poolside/";

/** Safe default temperature for Laguna models when the caller sets none. */
export const POOLSIDE_DEFAULT_TEMPERATURE = 0.7;

/** Sampling fields Poolside ignores; stripped so they never reach the wire. */
const POOLSIDE_UNSUPPORTED_SAMPLING_FIELDS = [
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "frequency_penalty",
  "n",
] as const;

/** Applies Poolside's temperature-only sampling contract to a request payload. */
export function sanitizePoolsideSampling(payload: Record<string, unknown>): void {
  for (const field of POOLSIDE_UNSUPPORTED_SAMPLING_FIELDS) {
    delete payload[field];
  }
  if (typeof payload.temperature !== "number") {
    payload.temperature = POOLSIDE_DEFAULT_TEMPERATURE;
  }
}

/** Restores the `poolside/` prefix the endpoint expects on the wire model id. */
export function applyPoolsideModelId(payload: Record<string, unknown>): void {
  if (
    typeof payload.model === "string" &&
    payload.model.length > 0 &&
    !payload.model.startsWith(POOLSIDE_MODEL_ID_PREFIX)
  ) {
    payload.model = `${POOLSIDE_MODEL_ID_PREFIX}${payload.model}`;
  }
}

/** Wraps the stream fn to enforce Poolside's sampling and model-id contract. */
export function createPoolsideSamplingWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  return createPayloadPatchStreamWrapper(ctx.streamFn, ({ payload, model }) => {
    if (model.provider !== POOLSIDE_PROVIDER_ID || model.api !== "openai-completions") {
      return;
    }
    sanitizePoolsideSampling(payload);
    applyPoolsideModelId(payload);
  });
}

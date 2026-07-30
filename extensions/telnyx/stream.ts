/** Telnyx request payload policy for the OpenAI-compatible completions endpoint. */
import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  createAssistantMessageEventStream,
  streamSimple,
  type AssistantMessageEvent,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Telnyx error 10015 rejects `max_completion_tokens` (former `max_tokens`)
 * combined with function tools, but only on part of the catalog: every
 * Telnyx-hosted model rejects the pair while most proxied frontier routes
 * accept it (live-verified per model, 2026-07-29). `openai/gpt-4o` accepts and
 * `openai/gpt-4o-mini` rejects, so no vendor/family rule can express the
 * split; unknown models learn their behavior adaptively below.
 */
const CAP_REJECTING_BUNDLED_MODEL_IDS = [
  "moonshotai/Kimi-K3",
  "moonshotai/Kimi-K2.6",
  "moonshotai/Kimi-K2.5",
  "zai-org/GLM-5.2",
  "zai-org/GLM-5.1-FP8",
  "MiniMaxAI/MiniMax-M3-MXFP8",
  "MiniMaxAI/MiniMax-M2.7",
  "Qwen/Qwen3-235B-A22B",
];

// Process-local, bounded by catalog size: remembers models whose cap+tools
// requests the API rejected so their hot path skips the failing first attempt.
const capRejectedModelIds = new Set<string>(CAP_REJECTING_BUNDLED_MODEL_IDS);

/** Test-only: restore the cap-rejection cache to its bundled seed. */
export function resetTelnyxCapRejectionCacheForTest(): void {
  capRejectedModelIds.clear();
  for (const id of CAP_REJECTING_BUNDLED_MODEL_IDS) {
    capRejectedModelIds.add(id);
  }
}

function isTelnyxCapRejectionEvent(event: AssistantMessageEvent): boolean {
  if (event.type !== "error") {
    return false;
  }
  // The completions transport surfaces Telnyx's 400 without its JSON body
  // ("400 status code (no body)"), so the 10015 code is matched when present
  // and a bare 400 is accepted; the retry only caches when dropping the cap
  // actually fixed the request, so unrelated 400s stay visible to the caller.
  const message = event.error.errorMessage ?? "";
  return message.includes("10015") || /\b400\b/.test(message);
}

function stripPayloadTokenCaps(payload: unknown): void {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return;
  }
  const record = payload as Record<string, unknown>;
  delete record.max_tokens;
  delete record.max_completion_tokens;
}

function pushTransportFailure(
  writable: { push(event: unknown): void },
  model: { api: string; provider: string; id: string },
  error: unknown,
): void {
  writable.push({
    type: "error",
    reason: "error",
    error: {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    },
  });
}

/**
 * Preserves caller token caps wherever Telnyx honors them and drops the cap
 * only for models that reject cap+tools requests (error 10015): known
 * rejecting models are pre-stripped, unknown models retry once without the
 * cap and are remembered only when the retry succeeds.
 */
export function createTelnyxToolPayloadWrapper(
  ctx: ProviderWrapStreamFnContext,
): ProviderWrapStreamFnContext["streamFn"] {
  const underlying = ctx.streamFn ?? streamSimple;
  const withoutCaps: StreamFn = (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      async onPayload(payload, payloadModel) {
        // Run configured payload hooks first so they cannot restore the caps
        // this recovery request exists to remove.
        const replacement = await originalOnPayload?.(payload, payloadModel);
        const finalPayload = replacement && typeof replacement === "object" ? replacement : payload;
        stripPayloadTokenCaps(finalPayload);
        return finalPayload;
      },
    });
  };

  return (model, context, options) => {
    if (model.provider !== "telnyx" || model.api !== "openai-completions") {
      return underlying(model, context, options);
    }
    // Caps without tools are accepted everywhere; only tool requests trip 10015.
    const hasTools = (context.tools?.length ?? 0) > 0;
    if (!hasTools) {
      return underlying(model, context, options);
    }
    if (capRejectedModelIds.has(model.id)) {
      return withoutCaps(model, context, options);
    }

    // Unknown model: attempt with the caller's cap intact, then learn.
    const initial = underlying(model, context, options);
    const output = createAssistantMessageEventStream();
    const writable = output as unknown as { push(event: unknown): void; end(): void };

    void (async () => {
      try {
        const resolvedInitial = await Promise.resolve(initial);
        let forwarded = false;
        let retryWithoutCaps = false;
        for await (const event of resolvedInitial) {
          if (!forwarded && !options?.signal?.aborted && isTelnyxCapRejectionEvent(event)) {
            retryWithoutCaps = true;
            break;
          }
          writable.push(event);
          forwarded = true;
        }
        if (retryWithoutCaps) {
          const fallback = await Promise.resolve(withoutCaps(model, context, options));
          let fallbackErrored = false;
          for await (const event of fallback) {
            if (event.type === "error") {
              fallbackErrored = true;
            }
            writable.push(event);
          }
          if (!fallbackErrored) {
            // Dropping the cap fixed the request; skip the failing first
            // attempt for this model from now on.
            capRejectedModelIds.add(model.id);
          }
        }
      } catch (error) {
        pushTransportFailure(writable, model, error);
      } finally {
        writable.end();
      }
    })();

    return output;
  };
}

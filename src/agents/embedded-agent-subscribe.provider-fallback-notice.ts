/**
 * Surfaces provider-side (server-side) model fallbacks as lifecycle
 * fallback_step events.
 *
 * Anthropic can re-serve a Claude Fable 5 request that its safety classifiers
 * declined on Claude Opus 4.8 within a single API call (server-side fallback).
 * The transport layer records that switch as a `provider_fallback` diagnostic
 * on the assistant message and re-attributes `responseModel`, but nothing
 * announced it: status surfaces kept showing the requested model and the turn
 * looked like a normal reply. This module bridges the recorded diagnostic to
 * the same lifecycle `fallback_step` event shape the model-failover chain
 * emits, so existing consumers (TUI model indicator, observability sinks)
 * present provider-served fallbacks exactly like chain fallbacks.
 */
import { emitAgentEvent } from "../infra/agent-events.js";

/** Session identity fields forwarded onto the lifecycle event. */
export type ProviderFallbackLifecycleRunParams = {
  runId: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  lifecycleGeneration?: string;
};

type ProviderFallbackDetails = {
  provider?: unknown;
  fromModel?: unknown;
  toModel?: unknown;
};

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Formats a `provider/model` ref, the shape fallback_step consumers parse. */
function formatProviderModelRef(
  provider: string,
  model: unknown,
): string | undefined {
  const id = readNonEmptyString(model);
  return id ? `${provider}/${id}` : undefined;
}

/**
 * Emits one lifecycle fallback_step event per provider_fallback diagnostic on
 * the assistant message. Returns the number of events emitted.
 */
export function emitProviderFallbackLifecycleSteps(
  ctx: { params: ProviderFallbackLifecycleRunParams },
  message: { model?: unknown; diagnostics?: unknown },
): number {
  const diagnostics = Array.isArray(message?.diagnostics)
    ? message.diagnostics
    : [];
  let emitted = 0;
  for (const diagnostic of diagnostics) {
    if (!diagnostic || typeof diagnostic !== "object") {
      continue;
    }
    const record = diagnostic as { type?: unknown; details?: unknown };
    if (record.type !== "provider_fallback") {
      continue;
    }
    const details = (record.details ?? {}) as ProviderFallbackDetails;
    const provider = readNonEmptyString(details.provider);
    if (!provider) {
      continue;
    }
    const toModel = formatProviderModelRef(provider, details.toModel);
    if (!toModel) {
      // Without a serving model there is nothing for consumers to present.
      continue;
    }
    const fromModel =
      formatProviderModelRef(provider, details.fromModel) ??
      formatProviderModelRef(provider, message?.model);
    emitAgentEvent({
      runId: ctx.params.runId,
      ...(ctx.params.sessionKey ? { sessionKey: ctx.params.sessionKey } : {}),
      ...(ctx.params.sessionId ? { sessionId: ctx.params.sessionId } : {}),
      ...(ctx.params.agentId ? { agentId: ctx.params.agentId } : {}),
      ...(ctx.params.lifecycleGeneration
        ? { lifecycleGeneration: ctx.params.lifecycleGeneration }
        : {}),
      stream: "lifecycle",
      data: {
        phase: "fallback_step",
        fallbackStepType: "fallback_step",
        // Distinguishes provider-served fallbacks from OpenClaw chain steps
        // without changing how existing consumers parse the shared fields.
        fallbackStepSource: "provider_server_side",
        ...(fromModel ? { fallbackStepFromModel: fromModel } : {}),
        fallbackStepToModel: toModel,
        fallbackStepFromFailureDetail:
          "provider safety classifier declined the request; the provider served the response on its fallback model",
        fallbackStepFinalOutcome: "succeeded",
      },
    });
    emitted += 1;
  }
  return emitted;
}

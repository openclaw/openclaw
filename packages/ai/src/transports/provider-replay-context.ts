import type { Model, ProviderReplayState } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { shortHash } from "../utils/hash.js";

export type ProviderReplayContext = Readonly<
  Pick<ProviderReplayState, "provider" | "api" | "model" | "baseUrlHash" | "sessionHash">
>;

export function isProviderReplayContext(
  value: unknown,
): value is ProviderReplayContext & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.api === "string" &&
    typeof value.model === "string" &&
    (value.baseUrlHash === undefined || typeof value.baseUrlHash === "string") &&
    (value.sessionHash === undefined || typeof value.sessionHash === "string") &&
    // Records written before the credential path left the fence may still carry it.
    (value.authProfileHash === undefined || typeof value.authProfileHash === "string")
  );
}

function hashReplayContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

export function buildProviderReplayContext(
  model: Model,
  options?: { sessionId?: string },
): ProviderReplayContext {
  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrlHash: hashReplayContextValue(model.baseUrl),
    sessionHash: hashReplayContextValue(options?.sessionId),
  };
}

export function providerReplayContextMatches(
  state: ProviderReplayContext,
  context: ProviderReplayContext,
): boolean {
  // Replay state is fenced to its provider API, endpoint and session. Neither the
  // credential path nor the model is part of the fence: sessions switch both
  // routinely, and providers accept their own checkpoints across models. The
  // provider rejects encrypted items it cannot use, which the existing
  // encrypted-content recovery handles.
  return (
    state.provider === context.provider &&
    state.api === context.api &&
    state.baseUrlHash === context.baseUrlHash &&
    state.sessionHash === context.sessionHash
  );
}

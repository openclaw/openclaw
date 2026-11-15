import type { Model, ProviderReplayState } from "@openclaw/llm-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { shortHash } from "../utils/hash.js";

export type ProviderReplayContext = Readonly<
  Pick<
    ProviderReplayState,
    "provider" | "api" | "model" | "baseUrlHash" | "sessionHash" | "authProfileHash"
  >
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
    (value.authProfileHash === undefined || typeof value.authProfileHash === "string")
  );
}

function hashReplayContextValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? shortHash(normalized) : undefined;
}

export function buildProviderReplayContext(
  model: Model,
  options?: { authProfileId?: string; sessionId?: string },
): ProviderReplayContext {
  return {
    provider: model.provider,
    api: model.api,
    model: model.id,
    baseUrlHash: hashReplayContextValue(model.baseUrl),
    sessionHash: hashReplayContextValue(options?.sessionId),
    authProfileHash: hashReplayContextValue(options?.authProfileId),
  };
}

export function providerReplayContextMatches(
  state: ProviderReplayContext,
  context: ProviderReplayContext,
): boolean {
  // Replay state must stay fenced to its exact provider, model, endpoint, session, and auth identity.
  return (
    state.provider === context.provider &&
    state.api === context.api &&
    state.model === context.model &&
    state.baseUrlHash === context.baseUrlHash &&
    state.sessionHash === context.sessionHash &&
    state.authProfileHash === context.authProfileHash
  );
}

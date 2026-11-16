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
  // Replay state is fenced to its provider, model, endpoint and session. The auth
  // profile is deliberately not part of the fence: one credential reaches the
  // transport through different lookup paths (a profile or provider config), and
  // fencing on that path discarded a session's own checkpoints. The provider owns
  // credential binding and rejects foreign items (invalid_encrypted_content,
  // item_conflict), which the replay recovery already handles.
  return (
    state.provider === context.provider &&
    state.api === context.api &&
    state.model === context.model &&
    state.baseUrlHash === context.baseUrlHash &&
    state.sessionHash === context.sessionHash
  );
}

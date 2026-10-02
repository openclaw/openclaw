import { createHash } from "node:crypto";
/** Host-derived native identity shared by callback policies and storage adapters. */
export type PluginAsyncCallbackBinding = {
  pluginId: string;
  toolName: string;
  childSessionKey: string;
  childSessionId: string;
  childRunId: string;
  childGeneration?: number;
  childCreatedAt: number;
};

const PLUGIN_CALLBACK_MAX_TTL_MS = 24 * 60 * 60_000;
export const PLUGIN_CALLBACK_RECEIPT_RETENTION_MS = 24 * 60 * 60_000;
const PLUGIN_CALLBACK_MAX_PENDING_PER_PLUGIN = 100;
export const PLUGIN_CALLBACK_MAX_PENDING = 1_000;
export const PLUGIN_CALLBACK_MAX_RESULT_CHARS = 32_000;

export function hashPluginAsyncCallbackToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Plugins and tools share the same native continuation slot, not independent destinations. */
export function pluginAsyncCallbackSlot(binding: PluginAsyncCallbackBinding): string {
  return hashPluginAsyncCallbackToken(
    JSON.stringify([
      binding.childSessionKey,
      binding.childSessionId,
      binding.childRunId,
      binding.childGeneration ?? null,
      binding.childCreatedAt,
    ]),
  );
}

export function assertPluginAsyncCallbackCapacity(facts: {
  occupied: boolean;
  pluginPending: number;
  totalPending: number;
}): void {
  if (facts.occupied) {
    throw new Error("Native child already has an outstanding callback");
  }
  if (
    facts.pluginPending >= PLUGIN_CALLBACK_MAX_PENDING_PER_PLUGIN ||
    facts.totalPending >= PLUGIN_CALLBACK_MAX_PENDING
  ) {
    throw new Error(
      "Pending plugin callback capacity reached; settle existing work before retrying",
    );
  }
}

export function validatePluginAsyncCallbackDeadline(
  binding: PluginAsyncCallbackBinding,
  ttlMs: number,
  now: number,
): number {
  if (
    !binding.pluginId ||
    !binding.toolName ||
    !binding.childSessionKey ||
    !binding.childSessionId ||
    !binding.childRunId ||
    !Number.isFinite(binding.childCreatedAt) ||
    !Number.isSafeInteger(ttlMs) ||
    ttlMs < 1 ||
    ttlMs > PLUGIN_CALLBACK_MAX_TTL_MS
  ) {
    throw new Error("An admitted native child and a bounded callback deadline are required");
  }
  const expiresAt = now + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new Error("Callback deadline is outside the supported clock range");
  }
  return expiresAt;
}

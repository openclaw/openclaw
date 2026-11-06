import { randomUUID } from "node:crypto";
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
} from "openclaw/plugin-sdk/runtime-env";
import { clamp } from "openclaw/plugin-sdk/text-utility-runtime";

export type ReconnectPolicy = BackoffPolicy & {
  maxAttempts: number;
};

const DEFAULT_HEARTBEAT_SECONDS = 60;
export const DEFAULT_RECONNECT_POLICY: ReconnectPolicy = {
  initialMs: 2_000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12,
};

export function resolveHeartbeatSeconds(overrideSeconds?: number): number {
  if (typeof overrideSeconds === "number" && overrideSeconds > 0) {
    return overrideSeconds;
  }
  return DEFAULT_HEARTBEAT_SECONDS;
}

export function resolveReconnectPolicy(overrides?: Partial<ReconnectPolicy>): ReconnectPolicy {
  const merged: ReconnectPolicy = {
    ...DEFAULT_RECONNECT_POLICY,
    ...overrides,
  };

  merged.initialMs = Math.max(250, merged.initialMs);
  merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
  merged.factor = clamp(merged.factor, 1.1, 10);
  merged.jitter = clamp(merged.jitter, 0, 1);
  merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
  return merged;
}

export { computeBackoff, sleepWithAbort };

export function newConnectionId() {
  return randomUUID();
}

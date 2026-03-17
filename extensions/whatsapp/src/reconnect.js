import { randomUUID } from "node:crypto";
import { computeBackoff, sleepWithAbort } from "../../../src/infra/backoff.js";
import { clamp } from "../../../src/utils.js";
const DEFAULT_HEARTBEAT_SECONDS = 60;
const DEFAULT_RECONNECT_POLICY = {
  initialMs: 2e3,
  maxMs: 3e4,
  factor: 1.8,
  jitter: 0.25,
  maxAttempts: 12
};
function resolveHeartbeatSeconds(cfg, overrideSeconds) {
  const candidate = overrideSeconds ?? cfg.web?.heartbeatSeconds;
  if (typeof candidate === "number" && candidate > 0) {
    return candidate;
  }
  return DEFAULT_HEARTBEAT_SECONDS;
}
function resolveReconnectPolicy(cfg, overrides) {
  const reconnectOverrides = cfg.web?.reconnect ?? {};
  const overrideConfig = overrides ?? {};
  const merged = {
    ...DEFAULT_RECONNECT_POLICY,
    ...reconnectOverrides,
    ...overrideConfig
  };
  merged.initialMs = Math.max(250, merged.initialMs);
  merged.maxMs = Math.max(merged.initialMs, merged.maxMs);
  merged.factor = clamp(merged.factor, 1.1, 10);
  merged.jitter = clamp(merged.jitter, 0, 1);
  merged.maxAttempts = Math.max(0, Math.floor(merged.maxAttempts));
  return merged;
}
function newConnectionId() {
  return randomUUID();
}
export {
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_RECONNECT_POLICY,
  computeBackoff,
  newConnectionId,
  resolveHeartbeatSeconds,
  resolveReconnectPolicy,
  sleepWithAbort
};

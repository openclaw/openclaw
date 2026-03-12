import type { WempRuntimeSnapshot } from "./types.js";
import { toRecord } from "./utils.js";

type RuntimeSnapshotPatch = Partial<Omit<WempRuntimeSnapshot, "accountId">>;

const localRuntimeSnapshots = new Map<string, WempRuntimeSnapshot>();

function normalizeAccountId(accountId?: string): string {
  const value = typeof accountId === "string" ? accountId.trim() : "";
  return value || "default";
}

function toOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function toOptionalTimestamp(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return undefined;
}

function toOptionalError(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string") return value;
  return undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "unknown_error";
  if (typeof error === "string") return error;
  if (error === null || error === undefined) return "unknown_error";
  return String(error);
}

export function defaultRuntime(accountId = "default"): WempRuntimeSnapshot {
  const normalizedAccountId = normalizeAccountId(accountId);
  return {
    accountId: normalizedAccountId,
    running: false,
    connected: false,
    lastConnectedAt: null,
    lastInboundAt: null,
    lastOutboundAt: null,
    lastError: null,
  };
}

export function getLocalRuntimeSnapshot(accountId: string): WempRuntimeSnapshot {
  const normalizedAccountId = normalizeAccountId(accountId);
  return {
    ...(localRuntimeSnapshots.get(normalizedAccountId) ?? defaultRuntime(normalizedAccountId)),
  };
}

export function mergeLocalRuntimeSnapshot(
  accountId: string,
  patch: RuntimeSnapshotPatch,
): WempRuntimeSnapshot {
  const normalizedAccountId = normalizeAccountId(accountId);
  const current =
    localRuntimeSnapshots.get(normalizedAccountId) ?? defaultRuntime(normalizedAccountId);
  const next: WempRuntimeSnapshot = {
    ...current,
    ...patch,
    accountId: normalizedAccountId,
  };
  localRuntimeSnapshots.set(normalizedAccountId, next);
  return { ...next };
}

export function markRuntimeConnected(
  accountId: string,
  connected = true,
  now = Date.now(),
): WempRuntimeSnapshot {
  if (!connected) {
    return mergeLocalRuntimeSnapshot(accountId, {
      running: false,
      connected: false,
    });
  }
  return mergeLocalRuntimeSnapshot(accountId, {
    running: true,
    connected: true,
    lastConnectedAt: now,
    lastError: null,
  });
}

export function markRuntimeInbound(accountId: string, now = Date.now()): WempRuntimeSnapshot {
  return mergeLocalRuntimeSnapshot(accountId, {
    running: true,
    connected: true,
    lastInboundAt: now,
  });
}

export function markRuntimeOutbound(accountId: string, now = Date.now()): WempRuntimeSnapshot {
  return mergeLocalRuntimeSnapshot(accountId, {
    running: true,
    connected: true,
    lastOutboundAt: now,
  });
}

export function markRuntimeError(
  accountId: string,
  error: string | Error | null,
): WempRuntimeSnapshot {
  return mergeLocalRuntimeSnapshot(accountId, {
    lastError: error ? toErrorMessage(error) : null,
  });
}

export function mergeRuntimeSnapshot(accountId: string, runtime?: unknown): WempRuntimeSnapshot {
  const normalizedAccountId = normalizeAccountId(accountId);
  const current =
    localRuntimeSnapshots.get(normalizedAccountId) ?? defaultRuntime(normalizedAccountId);
  const runtimeRecord = toRecord(runtime);
  const merged: WempRuntimeSnapshot = {
    ...current,
    running: toOptionalBoolean(runtimeRecord.running) ?? current.running,
    connected: toOptionalBoolean(runtimeRecord.connected) ?? current.connected,
    lastConnectedAt: toOptionalTimestamp(runtimeRecord.lastConnectedAt) ?? current.lastConnectedAt,
    lastInboundAt: toOptionalTimestamp(runtimeRecord.lastInboundAt) ?? current.lastInboundAt,
    lastOutboundAt: toOptionalTimestamp(runtimeRecord.lastOutboundAt) ?? current.lastOutboundAt,
    lastError: toOptionalError(runtimeRecord.lastError) ?? current.lastError,
    accountId: normalizedAccountId,
  };
  localRuntimeSnapshots.set(normalizedAccountId, merged);
  return { ...merged };
}

import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMatrixTargetIdentity } from "./target-ids.js";

export function trimMaybeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveMatrixRoomTargetId(value: unknown): string | undefined {
  const trimmed = trimMaybeString(value);
  if (!trimmed) {
    return undefined;
  }
  const target = resolveMatrixTargetIdentity(trimmed);
  return target?.kind === "room" && target.id.startsWith("!") ? target.id : undefined;
}

export function resolveMatrixSessionAccountId(value: unknown): string | undefined {
  const trimmed = trimMaybeString(value);
  return trimmed ? normalizeAccountId(trimmed) : undefined;
}

export function resolveMatrixStoredRoomId(params: {
  deliveryTo?: unknown;
  lastTo?: unknown;
  originTo?: unknown;
}): string | undefined {
  return (
    resolveMatrixRoomTargetId(params.deliveryTo) ??
    resolveMatrixRoomTargetId(params.lastTo) ??
    resolveMatrixRoomTargetId(params.originTo)
  );
}

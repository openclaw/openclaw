import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import { mutateBindingsForTargetSession } from "./thread-bindings.session-shared.js";
import type { ThreadBindingRecord } from "./thread-bindings.types.js";

function createDurationUpdate(field: "idleTimeoutMs" | "maxAgeMs", raw: number) {
  const duration = resolveNonNegativeIntegerOption(raw, 0);
  return (existing: ThreadBindingRecord, now: number): ThreadBindingRecord => ({
    ...existing,
    [field]: duration,
    ...(field === "maxAgeMs" ? { boundAt: now } : {}),
    lastActivityAt: now,
  });
}

function createDurationSetter<Field extends "idleTimeoutMs" | "maxAgeMs">(field: Field) {
  type Params = {
    targetSessionKey: string;
    accountId?: string;
  } & Record<Field, number>;
  return async (input: Params): Promise<ThreadBindingRecord[]> => {
    const params = { ...input };
    return mutateBindingsForTargetSession(params, createDurationUpdate(field, params[field]));
  };
}

export const setThreadBindingIdleTimeoutBySessionKeyAsync = createDurationSetter("idleTimeoutMs");
export const setThreadBindingMaxAgeBySessionKeyAsync = createDurationSetter("maxAgeMs");

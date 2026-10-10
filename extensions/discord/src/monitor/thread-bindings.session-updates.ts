import { resolveNonNegativeIntegerOption } from "openclaw/plugin-sdk/number-runtime";
import {
  resolveBindingIdsForTargetSession,
  mutateBindingsForTargetSession,
  updateBindingsForTargetSessionSync,
} from "./thread-bindings.session-shared.js";
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

function createDurationSetters<Field extends "idleTimeoutMs" | "maxAgeMs">(field: Field) {
  type Params = {
    targetSessionKey: string;
    accountId?: string;
  } & Record<Field, number>;
  return {
    setAsync: async (input: Params): Promise<ThreadBindingRecord[]> => {
      const params = { ...input };
      return mutateBindingsForTargetSession(params, createDurationUpdate(field, params[field]));
    },
    set: (params: Params): ThreadBindingRecord[] => {
      const ids = resolveBindingIdsForTargetSession(params);
      return updateBindingsForTargetSessionSync(ids, createDurationUpdate(field, params[field]));
    },
  };
}

const idleSetters = createDurationSetters("idleTimeoutMs");
const maxAgeSetters = createDurationSetters("maxAgeMs");

export const setThreadBindingIdleTimeoutBySessionKeyAsync = idleSetters.setAsync;
export const setThreadBindingMaxAgeBySessionKeyAsync = maxAgeSetters.setAsync;

/** @deprecated Use the awaited lifecycle setter; retained for the generic SDK contract. */
export const setThreadBindingIdleTimeoutBySessionKey = idleSetters.set;

/** @deprecated Use the awaited lifecycle setter; retained for the generic SDK contract. */
export const setThreadBindingMaxAgeBySessionKey = maxAgeSetters.set;

import { isRecord } from "@openclaw/normalization-core/record-coerce";

/** JSON remains canonical; the outbox writer stores this predicate with its payload. */
export function deriveContextEngineTurnOutboxState(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.state === "string" ? payload.state : null;
}

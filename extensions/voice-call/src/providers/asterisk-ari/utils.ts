import crypto from "node:crypto";
import type { NormalizedEvent } from "../../types.js";

export function nowMs(): number {
  return Date.now();
}

export function buildEndpoint(to: string, trunk?: string): string {
  if (to.includes("/")) {
    return to;
  }
  const t = trunk?.trim();
  return t ? `PJSIP/${t}/${to}` : `PJSIP/${to}`;
}

// NOTE: Omit<Union, K> does NOT preserve per-variant fields because keyof(Union)
// only includes keys common to all members. Use a distributive conditional.
//
// We must distribute over a *type parameter*; using `NormalizedEvent extends any` directly
// does not distribute.
type DistributeEventInput<T> = T extends any ? Omit<T, "id" | "timestamp"> : never;
export type NormalizedEventInput = DistributeEventInput<NormalizedEvent>;

export function makeEvent(partial: NormalizedEventInput): NormalizedEvent {
  return {
    id: crypto.randomUUID(),
    timestamp: nowMs(),
    ...partial,
  } as NormalizedEvent;
}

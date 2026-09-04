import { createHash, randomUUID } from "node:crypto";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { LobsterEnvelope, LobsterRunnerParams } from "./lobster-runner.js";

type ContinuationRecord =
  | {
      kind: "reservation";
      sessionKey: string;
      sessionId: string;
      expiresAt: number;
      leaseId: string;
    }
  | {
      kind: "binding";
      sessionKey: string;
      sessionId: string;
      expiresAt: number;
      credentialKey: string;
    }
  | {
      kind: "claim";
      sessionKey: string;
      sessionId: string;
      expiresAt: number;
      credentialKey: string;
      leaseId: string;
    };
type LeasedContinuationRecord = Extract<ContinuationRecord, { kind: "reservation" | "claim" }>;

// Each checkpoint gets one fixed deadline so retries cannot keep abandoned
// continuations alive and permanently exhaust plugin state.
export const LOBSTER_CONTINUATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type LobsterContinuationOwner = {
  sessionKey: string;
  sessionId: string;
  openStore: () => PluginStateSyncKeyedStore<unknown>;
  resolveCurrentSessionId: () => string | undefined;
};

export type LobsterContinuationClaim = {
  kind: "claim";
  slotKey: string;
  leaseId: string;
  expiresAt: number;
};

export type LobsterContinuationReservation = {
  kind: "reservation";
  slotKey: string;
  leaseId: string;
  expiresAt: number;
};

type LobsterContinuationLease = LobsterContinuationClaim | LobsterContinuationReservation;

function credentialKey(value: string): string {
  const digest = createHash("sha256").update("token\0").update(value.trim()).digest("hex");
  return `credential:${digest}`;
}

function paramsCredentialKey(params: Pick<LobsterRunnerParams, "token">): string | undefined {
  return params.token?.trim() ? credentialKey(params.token) : undefined;
}

function envelopeCredentialKey(
  envelope: Extract<LobsterEnvelope, { ok: true }>,
): string | undefined {
  if (envelope.status === "needs_input" && envelope.requiresInput) {
    return credentialKey(envelope.requiresInput.resumeToken);
  }
  return undefined;
}

function readContinuationRecord(value: unknown): ContinuationRecord | undefined {
  const expiresAt = isRecord(value) ? value.expiresAt : undefined;
  if (
    !isRecord(value) ||
    typeof value.sessionKey !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof expiresAt !== "number" ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= 0
  ) {
    return undefined;
  }
  if (value.kind === "binding" && typeof value.credentialKey === "string") {
    return {
      kind: "binding",
      sessionKey: value.sessionKey,
      sessionId: value.sessionId,
      expiresAt,
      credentialKey: value.credentialKey,
    };
  }
  if (value.kind === "reservation" && typeof value.leaseId === "string") {
    return {
      kind: "reservation",
      sessionKey: value.sessionKey,
      sessionId: value.sessionId,
      expiresAt,
      leaseId: value.leaseId,
    };
  }
  return value.kind === "claim" &&
    typeof value.credentialKey === "string" &&
    typeof value.leaseId === "string"
    ? {
        kind: "claim",
        sessionKey: value.sessionKey,
        sessionId: value.sessionId,
        expiresAt,
        credentialKey: value.credentialKey,
        leaseId: value.leaseId,
      }
    : undefined;
}

function readActiveContinuationRecord(value: unknown): ContinuationRecord | undefined {
  const record = readContinuationRecord(value);
  return record && record.expiresAt > Date.now() ? record : undefined;
}

function isStoredOwnedLease(
  value: unknown,
  owner: LobsterContinuationOwner,
  lease: LobsterContinuationLease,
): value is LeasedContinuationRecord {
  const record = readContinuationRecord(value);
  return (
    record?.kind === lease.kind &&
    record.sessionKey === owner.sessionKey &&
    record.sessionId === owner.sessionId &&
    record.leaseId === lease.leaseId &&
    record.expiresAt === lease.expiresAt
  );
}

function isActiveOwnedLease(
  value: unknown,
  owner: LobsterContinuationOwner,
  lease: LobsterContinuationLease,
): value is LeasedContinuationRecord {
  return isStoredOwnedLease(value, owner, lease) && lease.expiresAt > Date.now();
}

function remainingTtlMs(expiresAt: number): number | undefined {
  const remaining = expiresAt - Date.now();
  return remaining > 0 ? remaining : undefined;
}

function unavailableError(): Error {
  return new Error(
    "Lobster continuation is unavailable, expired, or already used; rerun the workflow to create a new checkpoint",
  );
}

function assertCurrentSession(owner: LobsterContinuationOwner): void {
  if (owner.resolveCurrentSessionId() !== owner.sessionId) {
    throw new Error(
      "Lobster continuation session is no longer active; rerun the workflow in the current session",
    );
  }
}

export function bindLobsterContinuation(
  owner: LobsterContinuationOwner | undefined,
  envelope: Extract<LobsterEnvelope, { ok: true }>,
  lease: LobsterContinuationLease | undefined,
): boolean {
  const key = envelopeCredentialKey(envelope);
  if (!key) {
    return false;
  }
  if (!owner || !lease) {
    throw new Error(
      "Lobster continuation requires a bound OpenClaw session; rerun the workflow from a persistent session",
    );
  }
  assertCurrentSession(owner);
  const store = owner.openStore();
  // Plugin tool calls share one Gateway event loop and these store operations
  // are synchronous, so duplicate detection plus the slot update cannot interleave.
  const duplicate = store.entries().some((entry) => {
    if (entry.key === lease.slotKey) {
      return false;
    }
    const record = readActiveContinuationRecord(entry.value);
    return record?.kind !== "reservation" && record?.credentialKey === key;
  });
  if (duplicate) {
    throw new Error("Lobster runtime returned a duplicate continuation credential");
  }
  const expiresAt = Date.now() + LOBSTER_CONTINUATION_TTL_MS;
  const binding: ContinuationRecord = {
    kind: "binding",
    sessionKey: owner.sessionKey,
    sessionId: owner.sessionId,
    expiresAt,
    credentialKey: key,
  };
  if (
    !store.update?.(
      lease.slotKey,
      (current) => (isActiveOwnedLease(current, owner, lease) ? binding : undefined),
      { ttlMs: LOBSTER_CONTINUATION_TTL_MS },
    )
  ) {
    throw unavailableError();
  }
  return true;
}

export function reserveLobsterContinuation(
  owner: LobsterContinuationOwner | undefined,
): LobsterContinuationReservation | undefined {
  if (!owner) {
    return undefined;
  }
  assertCurrentSession(owner);
  const leaseId = randomUUID();
  const slotKey = `slot:${leaseId}`;
  const expiresAt = Date.now() + LOBSTER_CONTINUATION_TTL_MS;
  const reservation: ContinuationRecord = {
    kind: "reservation",
    sessionKey: owner.sessionKey,
    sessionId: owner.sessionId,
    expiresAt,
    leaseId,
  };
  if (
    !owner
      .openStore()
      .registerIfAbsent(slotKey, reservation, { ttlMs: LOBSTER_CONTINUATION_TTL_MS })
  ) {
    throw new Error("Lobster continuation slot reservation collided");
  }
  return { kind: "reservation", slotKey, leaseId, expiresAt };
}

export function claimLobsterContinuation(
  owner: LobsterContinuationOwner | undefined,
  params: Pick<LobsterRunnerParams, "token">,
): LobsterContinuationClaim {
  if (!owner) {
    throw unavailableError();
  }
  assertCurrentSession(owner);
  const store = owner.openStore();
  const key = paramsCredentialKey(params);
  if (!key) {
    throw unavailableError();
  }
  const match = store.entries().find((entry) => {
    const record = readActiveContinuationRecord(entry.value);
    return record?.kind !== "reservation" && record?.credentialKey === key;
  });
  const initial = match ? readActiveContinuationRecord(match.value) : undefined;
  const ttlMs = initial ? remainingTtlMs(initial.expiresAt) : undefined;
  if (!match || !initial || initial.kind === "reservation" || ttlMs === undefined) {
    throw unavailableError();
  }
  const leaseId = randomUUID();
  let foreignOwner = false;
  const claimed = store.update?.(
    match.key,
    (current) => {
      const latest = readActiveContinuationRecord(current);
      if (
        !latest ||
        latest.kind === "reservation" ||
        latest.credentialKey !== key ||
        latest.expiresAt !== initial.expiresAt
      ) {
        return undefined;
      }
      if (latest.sessionKey !== owner.sessionKey || latest.sessionId !== owner.sessionId) {
        foreignOwner = true;
        return undefined;
      }
      return latest.kind === "binding" ? { ...latest, kind: "claim", leaseId } : undefined;
    },
    { ttlMs },
  );
  if (!claimed) {
    if (foreignOwner) {
      throw new Error(
        "Lobster continuation belongs to another OpenClaw session; resume it from the session that created it",
      );
    }
    throw unavailableError();
  }
  return {
    kind: "claim",
    slotKey: match.key,
    leaseId,
    expiresAt: initial.expiresAt,
  };
}

export function assertLobsterContinuationClaimCurrent(
  owner: LobsterContinuationOwner,
  claim: LobsterContinuationClaim,
): void {
  assertCurrentSession(owner);
  if (!isActiveOwnedLease(owner.openStore().lookup(claim.slotKey), owner, claim)) {
    throw unavailableError();
  }
}

export function retireLobsterContinuation(
  owner: LobsterContinuationOwner,
  lease: LobsterContinuationLease,
): void {
  owner
    .openStore()
    .deleteIf?.(lease.slotKey, (current) => isStoredOwnedLease(current, owner, lease));
}

export function releaseLobsterContinuation(
  owner: LobsterContinuationOwner,
  claim: LobsterContinuationClaim,
): void {
  const store = owner.openStore();
  const ttlMs = remainingTtlMs(claim.expiresAt);
  if (ttlMs === undefined) {
    retireLobsterContinuation(owner, claim);
    return;
  }
  store.update?.(
    claim.slotKey,
    (current) =>
      isActiveOwnedLease(current, owner, claim) && current.kind === "claim"
        ? {
            kind: "binding",
            sessionKey: current.sessionKey,
            sessionId: current.sessionId,
            expiresAt: current.expiresAt,
            credentialKey: current.credentialKey,
          }
        : undefined,
    { ttlMs },
  );
}

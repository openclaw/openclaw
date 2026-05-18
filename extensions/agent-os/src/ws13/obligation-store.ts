// Agent OS WS13 — L1 proof: in-memory, process-local, disposable store.
//
// Holds runtime correlation state for the simulated proof only. Nothing is
// persisted to disk. IDs and the clock are deterministic so the generated
// markdown evidence is reproducible (and so prompt-cache ordering is stable).
// "Store unavailable" is a first-class modelled failure (Scenario G): callers
// must detect it and fail loud/unhealthy rather than silently pass.

import type {
  Ws13DeliveryObservation,
  Ws13DispatchObservation,
  Ws13MessageSendingObservation,
  Ws13ObligationRecord,
  Ws13TransitionEvidence,
} from "./types.js";

export class Ws13StoreUnavailableError extends Error {
  constructor() {
    super("ws13_store_unavailable");
    this.name = "Ws13StoreUnavailableError";
  }
}

// Deterministic simulated clock. Real time is never read in the proof.
export class Ws13Clock {
  private ms: number;

  constructor(startMs = Date.UTC(2026, 4, 17, 0, 0, 0)) {
    this.ms = startMs;
  }

  nowMs(): number {
    return this.ms;
  }

  nowIso(): string {
    return new Date(this.ms).toISOString();
  }

  advance(ms: number): void {
    this.ms += ms;
  }
}

export class Ws13ObligationStore {
  private available: boolean;
  private seq = 0;
  private readonly obligations = new Map<string, Ws13ObligationRecord>();
  private readonly dispatches: Ws13DispatchObservation[] = [];
  private readonly deliveries: Ws13DeliveryObservation[] = [];
  private readonly messageSendings: Ws13MessageSendingObservation[] = [];
  private readonly evidence: Ws13TransitionEvidence[] = [];

  constructor(opts?: { available?: boolean }) {
    this.available = opts?.available ?? true;
  }

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(value: boolean): void {
    this.available = value;
  }

  private assertAvailable(): void {
    if (!this.available) {
      throw new Ws13StoreUnavailableError();
    }
  }

  // Opaque, deterministic, monotonically increasing identifiers.
  nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }

  createObligation(record: Ws13ObligationRecord): Ws13ObligationRecord {
    this.assertAvailable();
    this.obligations.set(record.obligationId, record);
    return record;
  }

  getObligation(obligationId: string): Ws13ObligationRecord | undefined {
    this.assertAvailable();
    return this.obligations.get(obligationId);
  }

  // Reconcile by exact child run, then child session key.
  findByChild(opts: {
    childRunId?: string;
    childSessionKey?: string;
  }): Ws13ObligationRecord | undefined {
    this.assertAvailable();
    for (const rec of this.obligations.values()) {
      if (opts.childRunId && rec.childRunId === opts.childRunId) {
        return rec;
      }
    }
    for (const rec of this.obligations.values()) {
      if (
        opts.childSessionKey &&
        rec.childSessionKey === opts.childSessionKey
      ) {
        return rec;
      }
    }
    return undefined;
  }

  updateObligation(
    obligationId: string,
    patch: Partial<Ws13ObligationRecord>,
  ): Ws13ObligationRecord | undefined {
    this.assertAvailable();
    const existing = this.obligations.get(obligationId);
    if (!existing) {
      return undefined;
    }
    const next: Ws13ObligationRecord = { ...existing, ...patch };
    this.obligations.set(obligationId, next);
    return next;
  }

  allObligations(): readonly Ws13ObligationRecord[] {
    this.assertAvailable();
    return [...this.obligations.values()];
  }

  recordDispatch(observation: Ws13DispatchObservation): void {
    this.assertAvailable();
    this.dispatches.push(observation);
  }

  recordDelivery(observation: Ws13DeliveryObservation): void {
    this.assertAvailable();
    this.deliveries.push(observation);
  }

  recordMessageSending(observation: Ws13MessageSendingObservation): void {
    this.assertAvailable();
    this.messageSendings.push(observation);
  }

  dispatchObservations(): readonly Ws13DispatchObservation[] {
    return [...this.dispatches];
  }

  deliveryObservations(): readonly Ws13DeliveryObservation[] {
    return [...this.deliveries];
  }

  messageSendingObservations(): readonly Ws13MessageSendingObservation[] {
    return [...this.messageSendings];
  }

  // Evidence recording stays available-tolerant: a store-unavailable proof
  // still needs to record the "store unavailable" transition itself.
  recordEvidence(evidence: Ws13TransitionEvidence): void {
    this.evidence.push(evidence);
  }

  transitionEvidence(): readonly Ws13TransitionEvidence[] {
    return [...this.evidence];
  }

  // Disposable: drop all process-local state.
  reset(): void {
    this.seq = 0;
    this.obligations.clear();
    this.dispatches.length = 0;
    this.deliveries.length = 0;
    this.messageSendings.length = 0;
    this.evidence.length = 0;
  }
}

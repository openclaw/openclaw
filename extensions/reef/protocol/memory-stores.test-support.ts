import { randomBytes } from "@noble/hashes/utils.js";
import { createAuditEntry, type AuditEntry, type AuditStore } from "./audit.js";
import type { CompletedReplay, MessageBody, ReplayClaim, ReplayStore } from "./envelope.js";
import type { SignedReceipt } from "./receipts.js";

export class MemoryAuditStore implements AuditStore {
  readonly #auditKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #entries: AuditEntry[] = [];
  #head = { hash: "", seq: 0 };
  #tail: Promise<void> = Promise.resolve();

  constructor(auditKey: Uint8Array, rng: (length: number) => Uint8Array = randomBytes) {
    if (!(auditKey instanceof Uint8Array) || auditKey.length !== 32) {
      throw new Error("audit key must be 32 bytes");
    }
    this.#auditKey = auditKey.slice();
    this.#rng = rng;
  }

  async appendEvent(
    type: string,
    payload: unknown,
    ts = Math.floor(Date.now() / 1000),
  ): Promise<AuditEntry> {
    return this.#withLock(() => {
      const entry = createAuditEntry(type, payload, ts, this.#auditKey, this.#head, this.#rng);
      this.#entries.push(entry);
      this.#head = { hash: entry.entryHash, seq: entry.event.seq };
      return structuredClone(entry);
    });
  }

  async entries(): Promise<AuditEntry[]> {
    return this.#withLock(() => structuredClone(this.#entries));
  }

  #withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

interface ReplayRecord {
  envelopeHash: string;
  state: "available" | "in_flight" | "completed" | "consumed";
  receipt?: SignedReceipt;
  body?: MessageBody;
}

export class MemoryReplayStore implements ReplayStore {
  readonly #bindings = new Map<string, ReplayRecord>();

  async claim(peer: string, id: string, envelopeHash: string): Promise<ReplayClaim> {
    const key = replayKey(peer, id);
    const existing = this.#bindings.get(key);
    if (existing === undefined) {
      this.#bindings.set(key, { envelopeHash, state: "in_flight" });
      return "new";
    }
    if (existing.envelopeHash !== envelopeHash) {
      return "mismatch";
    }
    if (existing.state === "completed" || existing.state === "consumed") {
      return "duplicate";
    }
    if (existing.state === "in_flight") {
      return "in_flight";
    }
    existing.state = "in_flight";
    return "new";
  }

  async refresh(_peer: string, _id: string): Promise<void> {}

  async complete(
    peer: string,
    id: string,
    receipt: SignedReceipt,
    body?: MessageBody,
  ): Promise<void> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state !== "in_flight") {
      throw new Error("replay claim is not in flight");
    }
    if (receipt.id !== id) {
      throw new Error("receipt id does not match replay claim");
    }
    validateCompletion(receipt, body);
    existing.state = "completed";
    existing.receipt = structuredClone(receipt);
    if (body !== undefined) {
      existing.body = structuredClone(body);
    }
  }

  async consume(peer: string, id: string): Promise<void> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state !== "in_flight") {
      throw new Error("replay claim is not in flight");
    }
    existing.state = "consumed";
    delete existing.receipt;
    delete existing.body;
  }

  async release(peer: string, id: string): Promise<void> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state === "in_flight") {
      existing.state = "available";
    }
  }

  async completed(peer: string, id: string): Promise<CompletedReplay | undefined> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state !== "completed" || existing.receipt === undefined) {
      return undefined;
    }
    return existing.body === undefined
      ? { receipt: structuredClone(existing.receipt) }
      : { receipt: structuredClone(existing.receipt), body: structuredClone(existing.body) };
  }
}

function replayKey(peer: string, id: string): string {
  return `${peer}\n${id}`;
}

function validateCompletion(receipt: SignedReceipt, body: MessageBody | undefined): void {
  if ((receipt.status === "accepted") !== (body !== undefined)) {
    throw new Error("accepted replay completion requires body; rejected completion forbids body");
  }
}

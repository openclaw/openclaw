import { randomBytes } from "@noble/hashes/utils.js";
import { createAuditEntry, type AuditEntry, type AuditStore } from "./audit.js";
import type { CompletedReplay, MessageBody, ReplayClaim, ReplayStore } from "./envelope.js";
import type { SignedReceipt } from "./receipts.js";

const settled = () => undefined;
const replayKey = (peer: string, id: string) => `${peer}\n${id}`;

export class MemoryAuditStore implements AuditStore {
  readonly appendEvent: AuditStore["appendEvent"];
  readonly #entries: AuditEntry[] = [];
  #head = { hash: "", seq: 0 };
  #tail: Promise<void> = Promise.resolve();

  constructor(auditKey: Uint8Array, rng: (length: number) => Uint8Array = randomBytes) {
    if (!(auditKey instanceof Uint8Array) || auditKey.length !== 32) {
      throw new Error("audit key must be 32 bytes");
    }
    const key = auditKey.slice();
    this.appendEvent = async (type, payload, ts = Math.floor(Date.now() / 1000)) =>
      this.#withLock(() => {
        const entry = createAuditEntry(type, payload, ts, key, this.#head, rng);
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
    this.#tail = result.then(settled, settled);
    return result;
  }
}

interface ReplayRecord {
  envelopeHash: string;
  state: "available" | "in_flight" | "completed";
  result?: CompletedReplay;
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
    if (existing.state !== "available") {
      return existing.state === "completed" ? "duplicate" : "in_flight";
    }
    existing.state = "in_flight";
    return "new";
  }

  async refresh(_peer: string, _id: string): Promise<void> {}

  async complete(peer: string, id: string, receipt: SignedReceipt, body?: MessageBody) {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state !== "in_flight") {
      throw new Error("replay claim is not in flight");
    }
    if (receipt.id !== id) {
      throw new Error("receipt id does not match replay claim");
    }
    if ((receipt.status === "accepted") !== (body !== undefined)) {
      throw new Error("accepted replay completion requires body; rejected completion forbids body");
    }
    existing.state = "completed";
    existing.result = structuredClone(body === undefined ? { receipt } : { receipt, body });
  }

  async release(peer: string, id: string): Promise<void> {
    const existing = this.#bindings.get(replayKey(peer, id));
    if (existing?.state === "in_flight") {
      existing.state = "available";
    }
  }

  async completed(peer: string, id: string): Promise<CompletedReplay | undefined> {
    const existing = this.#bindings.get(replayKey(peer, id));
    return existing?.state === "completed" ? structuredClone(existing.result) : undefined;
  }
}

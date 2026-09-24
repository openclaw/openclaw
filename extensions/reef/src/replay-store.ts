import { createHash, randomUUID } from "node:crypto";
import { gcm } from "@noble/ciphers/aes.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { canonicalBytes } from "../protocol/canonical.js";
import { base64, decodeUtf8, fromBase64 } from "../protocol/encoding.js";
import {
  REEF_ENVELOPE_MAX_AGE_SECONDS,
  validateMessageBody,
  type CompletedReplay,
  type MessageBody,
  type ReplayClaim,
  type ReplayStore,
} from "../protocol/envelope.js";
import type { SignedReceipt } from "../protocol/receipts.js";

export const REEF_REPLAY_NAMESPACE = "replay";
export const REEF_REPLAY_MAX_ENTRIES = 3_000;
export const REEF_REPLAY_TTL_MS = (REEF_ENVELOPE_MAX_AGE_SECONDS + 24 * 60 * 60) * 1_000;

export type ReefReplayRecord = {
  peer: string;
  id: string;
  envelopeHash: string;
  state: "available" | "in_flight" | "completed" | "consumed";
  claimOwner?: string;
  claimExpiresAt?: number;
  receipt?: SignedReceipt;
  body?: { enc: string };
};

const REEF_REPLAY_CLAIM_LEASE_MS = 5 * 60_000;

export function reefReplayStoreKey(peer: string, id: string): string {
  return `binding:${createHash("sha256")
    .update(JSON.stringify([peer, id]))
    .digest("hex")}`;
}

function parseReplayRecord(value: ReefReplayRecord | undefined): ReefReplayRecord | undefined {
  if (!value) {
    return undefined;
  }
  if (
    typeof value.peer !== "string" ||
    typeof value.id !== "string" ||
    typeof value.envelopeHash !== "string" ||
    !["available", "in_flight", "completed", "consumed"].includes(value.state) ||
    (value.state === "in_flight" &&
      (typeof value.claimOwner !== "string" ||
        value.claimOwner.length === 0 ||
        !Number.isSafeInteger(value.claimExpiresAt) ||
        (value.claimExpiresAt ?? 0) <= 0))
  ) {
    throw new Error("invalid Reef replay state");
  }
  return value;
}

function encryptReplayBody(
  body: MessageBody,
  key: Uint8Array,
  rng: (length: number) => Uint8Array,
): { enc: string } {
  validateMessageBody(body);
  const nonce = rng(12);
  if (nonce.length !== 12) {
    throw new Error("replay body rng returned invalid nonce");
  }
  return { enc: base64(concatBytes(nonce, gcm(key, nonce).encrypt(canonicalBytes(body)))) };
}

function decryptReplayBody(body: { enc: string }, key: Uint8Array): MessageBody {
  const packed = fromBase64(body.enc);
  if (packed.length < 28) {
    throw new Error("invalid encrypted replay body");
  }
  const value = JSON.parse(
    decodeUtf8(gcm(key, packed.slice(0, 12)).decrypt(packed.slice(12))),
  ) as unknown;
  validateMessageBody(value);
  return value;
}

function validateReplayCompletion(receipt: SignedReceipt, body: MessageBody | undefined): void {
  if ((receipt.status === "accepted") !== (body !== undefined)) {
    throw new Error("accepted replay completion requires body; rejected completion forbids body");
  }
}

type ReplayDecision<T> = { value: ReefReplayRecord | undefined; result: T };
type ReplayMutation<T> = {
  decide: (current: ReefReplayRecord | undefined) => ReplayDecision<T>;
  publish?: (result: T) => void;
};

function prepareReplayCompletion(
  receipt: SignedReceipt,
  body: MessageBody | undefined,
  key: Uint8Array,
  rng: (length: number) => Uint8Array,
  freeze: boolean,
): () => Pick<ReefReplayRecord, "receipt" | "body"> {
  type Input = { receipt: SignedReceipt; body?: MessageBody };
  type Prepared<T> = { ok: true; value: T } | { ok: false; error: unknown };
  let input: Prepared<Input>;
  try {
    input = { ok: true, value: freeze ? structuredClone({ receipt, body }) : { receipt, body } };
  } catch (error) {
    input = { ok: false, error };
  }
  let prepared: Prepared<Pick<ReefReplayRecord, "receipt" | "body">> | undefined;
  // Capture inputs before storage waits, but defer validation and randomness until
  // a matching claim is observed. Conflicts reuse both successful and failed preparation.
  return () => {
    if (!prepared) {
      try {
        if (!input.ok) {
          throw input.error;
        }
        prepared = {
          ok: true,
          value: {
            receipt: structuredClone(input.value.receipt),
            ...(input.value.body ? { body: encryptReplayBody(input.value.body, key, rng) } : {}),
          },
        };
      } catch (error) {
        prepared = { ok: false, error };
      }
    }
    if (!prepared.ok) {
      throw prepared.error;
    }
    return prepared.value;
  };
}

export class ReefSqliteReplayStore implements ReplayStore {
  readonly #bodyKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #store: PluginStateKeyedStore<ReefReplayRecord>;
  readonly #legacy: PluginStateSyncKeyedStore<ReefReplayRecord> | undefined;
  readonly #comparison:
    | Required<Pick<PluginStateKeyedStore<ReefReplayRecord>, "observe" | "compareAndApply">>
    | undefined;
  readonly #claimOwners = new Map<string, string>();
  #pending = Promise.resolve();

  constructor(
    runtime: PluginRuntime,
    bodyKey: Uint8Array,
    rng: (length: number) => Uint8Array = randomBytes,
    maxEntries = REEF_REPLAY_MAX_ENTRIES,
  ) {
    if (bodyKey.length !== 32) {
      throw new Error("replay body key must be 32 bytes");
    }
    this.#bodyKey = bodyKey.slice();
    this.#rng = rng;
    const options = {
      namespace: REEF_REPLAY_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new" as const,
      // Once this expires, the protocol rejects the original envelope by age.
      // The margin covers clock skew and delayed local processing.
      defaultTtlMs: REEF_REPLAY_TTL_MS,
    };
    this.#store = runtime.state.openKeyedStore<ReefReplayRecord>(options);
    const { observe, compareAndApply } = this.#store;
    if (observe && compareAndApply) {
      this.#comparison = { observe, compareAndApply };
    } else {
      // Shipped hosts without comparisons retain the uninterrupted native mutation
      // and owner publication. Available worker failures never select this path.
      this.#legacy = runtime.state.openSyncKeyedStore<ReefReplayRecord>(options);
    }
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#pending.then(operation);
    this.#pending = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  #mutate<T>(key: string, prepare: () => ReplayMutation<T>): T | Promise<T> {
    const comparison = this.#comparison;
    if (!comparison) {
      const mutation = prepare();
      const update = this.#legacy?.update;
      if (!update) {
        throw new Error("Reef replay state requires atomic plugin-state updates");
      }
      let decision: ReplayDecision<T> | undefined;
      update(key, (current) => {
        decision = mutation.decide(parseReplayRecord(current));
        return decision.value;
      });
      if (!decision) {
        throw new Error("Reef replay update did not evaluate current state");
      }
      mutation.publish?.(decision.result);
      return decision.result;
    }
    return this.#enqueue(async () => {
      // Keep invocation order through durable settlement and local owner publication.
      const mutation = prepare();
      let observation = await comparison.observe(key);
      for (;;) {
        let decision: ReplayDecision<T>;
        try {
          decision = mutation.decide(parseReplayRecord(observation.value));
        } catch (error) {
          // A failed native callback rolls back expiry cleanup. Validate this error's
          // observation without sweeping or writing before exposing it to the caller.
          const result = await comparison.compareAndApply(key, observation.comparison, {
            operation: "delete",
            action: "keep",
          });
          if (result.status !== "conflict") {
            throw error;
          }
          observation = result.current;
          continue;
        }
        const result = await comparison.compareAndApply(
          key,
          observation.comparison,
          decision.value === undefined
            ? { operation: "update", action: "keep" }
            : { operation: "update", action: "set", value: decision.value },
        );
        if (result.status === "conflict") {
          observation = result.current;
          continue;
        }
        mutation.publish?.(decision.result);
        return decision.result;
      }
    });
  }

  async claim(peer: string, id: string, envelopeHash: string): Promise<ReplayClaim> {
    const key = reefReplayStoreKey(peer, id);
    return this.#mutate<ReplayClaim>(key, () => {
      const owner = randomUUID();
      const now = Date.now();
      const claim = { claimOwner: owner, claimExpiresAt: now + REEF_REPLAY_CLAIM_LEASE_MS };
      return {
        decide: (existing) => {
          if (!existing) {
            return {
              value: { peer, id, envelopeHash, state: "in_flight", ...claim },
              result: "new",
            };
          }
          if (
            existing.peer !== peer ||
            existing.id !== id ||
            existing.envelopeHash !== envelopeHash
          ) {
            return { value: existing, result: "mismatch" };
          }
          if (existing.state === "completed" || existing.state === "consumed") {
            return { value: existing, result: "duplicate" };
          }
          if (existing.state === "in_flight" && (existing.claimExpiresAt ?? 0) > Date.now()) {
            return { value: existing, result: "in_flight" };
          }
          return { value: { ...existing, state: "in_flight", ...claim }, result: "new" };
        },
        publish: (result) => {
          if (result === "new") {
            this.#claimOwners.set(key, owner);
          }
        },
      };
    });
  }

  async refresh(peer: string, id: string): Promise<void> {
    const key = reefReplayStoreKey(peer, id);
    const refresh = () => {
      const owner = this.#claimOwners.get(key);
      if (!owner) {
        throw new Error("replay claim is not in flight");
      }
      const claimExpiresAt = Date.now() + REEF_REPLAY_CLAIM_LEASE_MS;
      return {
        decide: (existing: ReefReplayRecord | undefined) => ({
          value:
            existing?.state === "in_flight" && existing.claimOwner === owner
              ? {
                  ...existing,
                  claimExpiresAt: this.#comparison
                    ? claimExpiresAt
                    : Date.now() + REEF_REPLAY_CLAIM_LEASE_MS,
                }
              : existing,
          result: existing?.state === "in_flight" && existing.claimOwner === owner,
        }),
        publish: (refreshed: boolean) => {
          if (!refreshed) {
            this.#claimOwners.delete(key);
            throw new Error("replay claim is not in flight");
          }
        },
      };
    };
    await this.#mutate(key, refresh);
  }

  async complete(
    peer: string,
    id: string,
    receipt: SignedReceipt,
    body?: MessageBody,
  ): Promise<void> {
    if (receipt.id !== id) {
      throw new Error("receipt id does not match replay claim");
    }
    validateReplayCompletion(receipt, body);
    const completion = prepareReplayCompletion(
      receipt,
      body,
      this.#bodyKey,
      this.#rng,
      Boolean(this.#comparison),
    );
    const key = reefReplayStoreKey(peer, id);
    await this.#mutate(key, () => {
      const owner = this.#claimOwners.get(key);
      return {
        decide: (existing) => {
          if (existing?.state !== "in_flight" || existing.claimOwner !== owner) {
            return { value: existing, result: false };
          }
          const { claimOwner: _claimOwner, claimExpiresAt: _claimExpiresAt, ...rest } = existing;
          return { value: { ...rest, state: "completed", ...completion() }, result: true };
        },
        publish: (completed) => {
          if (!completed) {
            throw new Error("replay claim is not in flight");
          }
          this.#claimOwners.delete(key);
        },
      };
    });
  }

  async consume(peer: string, id: string): Promise<void> {
    const key = reefReplayStoreKey(peer, id);
    await this.#mutate(key, () => {
      const owner = this.#claimOwners.get(key);
      return {
        decide: (existing) => {
          if (existing?.state !== "in_flight" || existing.claimOwner !== owner) {
            return { value: existing, result: false };
          }
          const {
            receipt: _receipt,
            body: _body,
            claimOwner: _claimOwner,
            claimExpiresAt: _claimExpiresAt,
            ...rest
          } = existing;
          return { value: { ...rest, state: "consumed" }, result: true };
        },
        publish: (consumed) => {
          if (!consumed) {
            throw new Error("replay claim is not in flight");
          }
          this.#claimOwners.delete(key);
        },
      };
    });
  }

  async release(peer: string, id: string): Promise<void> {
    const key = reefReplayStoreKey(peer, id);
    await this.#mutate(key, () => {
      const owner = this.#claimOwners.get(key);
      return {
        decide: (existing) => ({
          value:
            existing?.state === "in_flight" && existing.claimOwner === owner
              ? {
                  peer: existing.peer,
                  id: existing.id,
                  envelopeHash: existing.envelopeHash,
                  state: "available",
                }
              : existing,
          result: undefined,
        }),
        publish: () => {
          this.#claimOwners.delete(key);
        },
      };
    });
  }

  async completed(peer: string, id: string): Promise<CompletedReplay | undefined> {
    const read = (value: ReefReplayRecord | undefined) => {
      const existing = parseReplayRecord(value);
      if (
        existing?.peer !== peer ||
        existing.id !== id ||
        existing.state !== "completed" ||
        !existing.receipt
      ) {
        return undefined;
      }
      return existing.body
        ? {
            receipt: structuredClone(existing.receipt),
            body: decryptReplayBody(existing.body, this.#bodyKey),
          }
        : { receipt: structuredClone(existing.receipt) };
    };
    const key = reefReplayStoreKey(peer, id);
    if (this.#legacy) {
      return read(this.#legacy.lookup(key));
    }
    return this.#enqueue(async () => read(await this.#store.lookup(key)));
  }
}

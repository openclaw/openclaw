import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { gcm } from "@noble/ciphers/aes.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  base64,
  base64url,
  canonicalBytes,
  createAuditEntry,
  decodeUtf8,
  fromBase64,
  fromBase64url,
  generateIdentity,
  validateMessageBody,
  verifyChain,
  type AuditEntry,
  type AuditStore,
  type CompletedReplay,
  type MessageBody,
  type ReplayClaim,
  type ReplayStore,
  type ReviewApproval,
  type ReviewRequest,
  type SignedReceipt,
} from "../protocol/index.js";
import type { ReefKeys } from "./types.js";

export const REEF_KEYS_NAMESPACE = "identity";
export const REEF_KEYS_KEY = "keys";
export const REEF_KEYS_MAX_ENTRIES = 1;
export const REEF_KEYS_MIGRATION_NAMESPACE = "identity-migration";
export const REEF_KEYS_MIGRATION_KEY = "keys-json";
export const REEF_KEYS_MIGRATION_MAX_ENTRIES = 1;
export const REEF_AUDIT_NAMESPACE = "audit";
export const REEF_AUDIT_HEAD_KEY = "head";
export const REEF_AUDIT_MAX_ENTRIES = 30_000;
const REEF_REPLAY_NAMESPACE = "replay";
const REEF_REPLAY_MAX_ENTRIES = 3_000;
const REEF_REVIEWS_NAMESPACE = "reviews";
const REEF_REVIEWS_MAX_ENTRIES = 2_000;
const REEF_DELIVERED_NAMESPACE = "delivered";
const REEF_DELIVERED_MAX_ENTRIES = 5_000;
export const REEF_REGISTRATION_NAMESPACE = "registration";
export const REEF_REGISTRATION_IDENTITY_KEY = "identity";
export const REEF_REGISTRATION_SESSION_KEY = "setup-session";
export const REEF_REGISTRATION_MAX_ENTRIES = 2;

type ReefAuditHeadRecord = { kind: "head"; hash: string; seq: number };
type ReefAuditEntryRecord = { kind: "entry"; entry: AuditEntry };
export type ReefAuditStateRecord = ReefAuditHeadRecord | ReefAuditEntryRecord;

type ReefReplayRecord = {
  peer: string;
  id: string;
  envelopeHash: string;
  state: "available" | "in_flight" | "completed" | "consumed";
  claimOwner?: string;
  receipt?: SignedReceipt;
  body?: { enc: string };
};

const REEF_REPLAY_PROCESS_ID = randomUUID();

type ReefReviewRecord = { review: ReviewRequest; approved?: boolean };

export type ReefIdentityBinding = { handle: string; relayUrl: string };
export type ReefSetupSession = { session: string; relayUrl: string; email: string };

export function resolveStateDir(configured?: string): string {
  return configured ?? join(homedir(), ".openclaw", "data", "reef");
}

export function parseReefKeys(value: unknown): ReefKeys {
  if (!value || typeof value !== "object") {
    throw new Error("invalid Reef keys");
  }
  const keys = value as ReefKeys;
  if (
    fromBase64url(keys.signing?.publicKey ?? "").length !== 32 ||
    fromBase64url(keys.signing?.secretKey ?? "").length !== 32 ||
    fromBase64url(keys.encryption?.publicKey ?? "").length !== 32 ||
    fromBase64url(keys.encryption?.secretKey ?? "").length !== 32 ||
    fromBase64url(keys.auditKey ?? "").length !== 32 ||
    fromBase64url(keys.replayKey ?? "").length !== 32 ||
    !Number.isSafeInteger(keys.keyEpoch) ||
    keys.keyEpoch < 1
  ) {
    throw new Error("invalid Reef keys");
  }
  return structuredClone(keys);
}

function openKeysStore(runtime: PluginRuntime): PluginStateSyncKeyedStore<ReefKeys> {
  return runtime.state.openSyncKeyedStore<ReefKeys>({
    namespace: REEF_KEYS_NAMESPACE,
    maxEntries: REEF_KEYS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

export async function generateAndStoreKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  const migration = runtime.state.openSyncKeyedStore<{ pending: true }>({
    namespace: REEF_KEYS_MIGRATION_NAMESPACE,
    maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  if (migration.lookup(REEF_KEYS_MIGRATION_KEY)) {
    throw new Error(
      "Reef identity key migration is incomplete; repair the legacy keys.json and rerun openclaw doctor --fix",
    );
  }
  const identity = generateIdentity();
  const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
  const keys: ReefKeys = {
    ...identity,
    auditKey: base64url(random(32)),
    replayKey: base64url(random(32)),
    keyEpoch: 1,
  };
  if (!openKeysStore(runtime).registerIfAbsent(REEF_KEYS_KEY, keys)) {
    throw new Error("Reef keys already exist in plugin state");
  }
  return keys;
}

export async function loadKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  const value = openKeysStore(runtime).lookup(REEF_KEYS_KEY);
  if (!value) {
    const error = new Error("Reef keys are missing from plugin state") as Error & {
      code?: string;
    };
    error.code = "ENOENT";
    throw error;
  }
  return parseReefKeys(value);
}

export function reefAuditEntryKey(entryHash: string): string {
  return `entry:${entryHash}`;
}

function parseAuditHead(value: ReefAuditStateRecord | undefined): ReefAuditHeadRecord {
  if (value === undefined) {
    return { kind: "head", hash: "", seq: 0 };
  }
  if (
    value.kind !== "head" ||
    typeof value.hash !== "string" ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < 0 ||
    (value.seq === 0) !== (value.hash === "")
  ) {
    throw new Error("invalid Reef audit head");
  }
  return value;
}

function parseAuditEntryRecord(value: ReefAuditStateRecord | undefined): AuditEntry {
  if (!value || value.kind !== "entry") {
    throw new Error("missing Reef audit entry");
  }
  return value.entry;
}

class ReefSqliteAuditStore implements AuditStore {
  readonly #auditKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #store: PluginStateSyncKeyedStore<ReefAuditStateRecord>;

  constructor(
    runtime: PluginRuntime,
    auditKey: Uint8Array,
    rng: (length: number) => Uint8Array = randomBytes,
  ) {
    if (auditKey.length !== 32) {
      throw new Error("audit key must be 32 bytes");
    }
    this.#auditKey = auditKey.slice();
    this.#rng = rng;
    this.#store = runtime.state.openSyncKeyedStore<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: REEF_AUDIT_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
  }

  async appendEvent(
    type: string,
    payload: unknown,
    ts = Math.floor(Date.now() / 1000),
  ): Promise<AuditEntry> {
    const update = this.#store.update;
    if (!update) {
      throw new Error("Reef audit state requires atomic plugin-state updates");
    }
    for (let attempt = 0; attempt < 32; attempt++) {
      const head = parseAuditHead(this.#store.lookup(REEF_AUDIT_HEAD_KEY));
      const entry = createAuditEntry(type, payload, ts, this.#auditKey, head, this.#rng);
      const entryKey = reefAuditEntryKey(entry.entryHash);
      const inserted = this.#store.registerIfAbsent(entryKey, { kind: "entry", entry });
      let advanced = false;
      update(REEF_AUDIT_HEAD_KEY, (current) => {
        const latest = parseAuditHead(current);
        if (latest.hash !== head.hash || latest.seq !== head.seq) {
          return latest;
        }
        advanced = true;
        return { kind: "head", hash: entry.entryHash, seq: entry.event.seq };
      });
      if (advanced) {
        return structuredClone(entry);
      }
      if (inserted) {
        this.#store.delete(entryKey);
      }
    }
    throw new Error("Reef audit append contention exceeded retry budget");
  }

  async entries(): Promise<AuditEntry[]> {
    const head = parseAuditHead(this.#store.lookup(REEF_AUDIT_HEAD_KEY));
    const reversed: AuditEntry[] = [];
    let hash = head.hash;
    for (let seq = head.seq; seq > 0; seq--) {
      const entry = parseAuditEntryRecord(this.#store.lookup(reefAuditEntryKey(hash)));
      if (entry.entryHash !== hash || entry.event.seq !== seq) {
        throw new Error("invalid Reef audit chain state");
      }
      reversed.push(entry);
      hash = entry.prevHash;
    }
    const entries = reversed.reverse();
    if (hash !== "" || !verifyChain(entries, { head: head.hash, length: head.seq })) {
      throw new Error("invalid Reef audit chain state");
    }
    return structuredClone(entries);
  }
}

function reefReplayStoreKey(peer: string, id: string): string {
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
    !["available", "in_flight", "completed", "consumed"].includes(value.state)
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

class ReefSqliteReplayStore implements ReplayStore {
  readonly #bodyKey: Uint8Array;
  readonly #rng: (length: number) => Uint8Array;
  readonly #store: PluginStateSyncKeyedStore<ReefReplayRecord>;

  constructor(
    runtime: PluginRuntime,
    bodyKey: Uint8Array,
    rng: (length: number) => Uint8Array = randomBytes,
  ) {
    if (bodyKey.length !== 32) {
      throw new Error("replay body key must be 32 bytes");
    }
    this.#bodyKey = bodyKey.slice();
    this.#rng = rng;
    this.#store = runtime.state.openSyncKeyedStore<ReefReplayRecord>({
      namespace: REEF_REPLAY_NAMESPACE,
      maxEntries: REEF_REPLAY_MAX_ENTRIES,
    });
  }

  #update(
    peer: string,
    id: string,
    updateValue: (current: ReefReplayRecord | undefined) => ReefReplayRecord | undefined,
  ): boolean {
    const update = this.#store.update;
    if (!update) {
      throw new Error("Reef replay state requires atomic plugin-state updates");
    }
    return update(reefReplayStoreKey(peer, id), (current) =>
      updateValue(parseReplayRecord(current)),
    );
  }

  async claim(peer: string, id: string, envelopeHash: string): Promise<ReplayClaim> {
    let result: ReplayClaim = "new";
    this.#update(peer, id, (existing) => {
      if (!existing) {
        return {
          peer,
          id,
          envelopeHash,
          state: "in_flight",
          claimOwner: REEF_REPLAY_PROCESS_ID,
        };
      }
      if (existing.peer !== peer || existing.id !== id || existing.envelopeHash !== envelopeHash) {
        result = "mismatch";
        return existing;
      }
      if (existing.state === "completed" || existing.state === "consumed") {
        result = "duplicate";
        return existing;
      }
      if (existing.state === "in_flight" && existing.claimOwner === REEF_REPLAY_PROCESS_ID) {
        result = "in_flight";
        return existing;
      }
      return { ...existing, state: "in_flight", claimOwner: REEF_REPLAY_PROCESS_ID };
    });
    return result;
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
    let completed = false;
    this.#update(peer, id, (existing) => {
      if (existing?.state !== "in_flight" || existing.claimOwner !== REEF_REPLAY_PROCESS_ID) {
        return existing;
      }
      completed = true;
      return {
        ...existing,
        state: "completed",
        receipt: structuredClone(receipt),
        ...(body ? { body: encryptReplayBody(body, this.#bodyKey, this.#rng) } : {}),
      };
    });
    if (!completed) {
      throw new Error("replay claim is not in flight");
    }
  }

  async consume(peer: string, id: string): Promise<void> {
    let consumed = false;
    this.#update(peer, id, (existing) => {
      if (existing?.state !== "in_flight" || existing.claimOwner !== REEF_REPLAY_PROCESS_ID) {
        return existing;
      }
      consumed = true;
      const { receipt: _receipt, body: _body, ...rest } = existing;
      return { ...rest, state: "consumed" };
    });
    if (!consumed) {
      throw new Error("replay claim is not in flight");
    }
  }

  async release(peer: string, id: string): Promise<void> {
    this.#update(peer, id, (existing) =>
      existing?.state === "in_flight" && existing.claimOwner === REEF_REPLAY_PROCESS_ID
        ? { ...existing, state: "available", claimOwner: undefined }
        : existing,
    );
  }

  async completed(peer: string, id: string): Promise<CompletedReplay | undefined> {
    const existing = parseReplayRecord(this.#store.lookup(reefReplayStoreKey(peer, id)));
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
  }
}

export class ReviewApprovalStore {
  readonly #store: PluginStateSyncKeyedStore<ReefReviewRecord>;

  constructor(runtime: PluginRuntime) {
    this.#store = runtime.state.openSyncKeyedStore<ReefReviewRecord>({
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries: REEF_REVIEWS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
  }

  async request(review: ReviewRequest): Promise<ReviewApproval | undefined> {
    const current = this.#store.lookup(review.approvalDigest);
    if (current?.approved !== undefined) {
      return { approved: current.approved, approvalDigest: review.approvalDigest };
    }
    this.#store.registerIfAbsent(review.approvalDigest, { review: structuredClone(review) });
    const persisted = this.#store.lookup(review.approvalDigest);
    return persisted?.approved === undefined
      ? undefined
      : { approved: persisted.approved, approvalDigest: review.approvalDigest };
  }

  async decide(digest: string, approved: boolean): Promise<boolean> {
    const update = this.#store.update;
    if (!update) {
      throw new Error("Reef review state requires atomic plugin-state updates");
    }
    let found = false;
    update(digest, (current) => {
      if (!current) {
        return undefined;
      }
      found = true;
      return { ...current, approved };
    });
    return found;
  }

  async list(): Promise<ReviewRequest[]> {
    return this.#store
      .entries()
      .filter((entry) => entry.value.approved === undefined)
      .map((entry) => structuredClone(entry.value.review));
  }
}

export class ReefDeliveredStore {
  readonly #store: PluginStateSyncKeyedStore<{ id: string }>;

  constructor(runtime: PluginRuntime) {
    this.#store = runtime.state.openSyncKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries: REEF_DELIVERED_MAX_ENTRIES,
    });
  }

  async has(id: string): Promise<boolean> {
    return this.#store.lookup(id)?.id === id;
  }

  async add(id: string): Promise<void> {
    this.#store.register(id, { id });
  }
}

function openRegistrationStore(
  runtime: PluginRuntime,
): PluginStateSyncKeyedStore<ReefIdentityBinding | ReefSetupSession> {
  return runtime.state.openSyncKeyedStore<ReefIdentityBinding | ReefSetupSession>({
    namespace: REEF_REGISTRATION_NAMESPACE,
    maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

export function parseReefIdentityBinding(value: unknown): ReefIdentityBinding | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as Partial<ReefIdentityBinding>;
  return typeof parsed.handle === "string" &&
    parsed.handle.length > 0 &&
    typeof parsed.relayUrl === "string" &&
    parsed.relayUrl.length > 0
    ? { handle: parsed.handle, relayUrl: parsed.relayUrl }
    : undefined;
}

export function parseReefSetupSession(value: unknown): ReefSetupSession | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const parsed = value as Partial<ReefSetupSession>;
  return typeof parsed.session === "string" &&
    parsed.session.length > 0 &&
    typeof parsed.relayUrl === "string" &&
    parsed.relayUrl.length > 0 &&
    typeof parsed.email === "string" &&
    parsed.email.length > 0
    ? { session: parsed.session, relayUrl: parsed.relayUrl, email: parsed.email }
    : undefined;
}

export function loadReefIdentityBinding(runtime: PluginRuntime): ReefIdentityBinding | undefined {
  return parseReefIdentityBinding(
    openRegistrationStore(runtime).lookup(REEF_REGISTRATION_IDENTITY_KEY),
  );
}

export function saveReefIdentityBinding(
  runtime: PluginRuntime,
  binding: ReefIdentityBinding,
): void {
  const parsed = parseReefIdentityBinding(binding);
  if (!parsed) {
    throw new Error("invalid Reef identity binding");
  }
  openRegistrationStore(runtime).register(REEF_REGISTRATION_IDENTITY_KEY, parsed);
}

export function loadReefSetupSession(runtime: PluginRuntime): ReefSetupSession | undefined {
  return parseReefSetupSession(
    openRegistrationStore(runtime).lookup(REEF_REGISTRATION_SESSION_KEY),
  );
}

export function saveReefSetupSession(runtime: PluginRuntime, session: ReefSetupSession): void {
  const parsed = parseReefSetupSession(session);
  if (!parsed) {
    throw new Error("invalid Reef setup session");
  }
  openRegistrationStore(runtime).register(REEF_REGISTRATION_SESSION_KEY, parsed);
}

export function clearReefSetupSession(runtime: PluginRuntime): void {
  openRegistrationStore(runtime).delete(REEF_REGISTRATION_SESSION_KEY);
}

export function openStores(runtime: PluginRuntime, keys: ReefKeys) {
  return {
    audit: new ReefSqliteAuditStore(runtime, fromBase64url(keys.auditKey)),
    replay: new ReefSqliteReplayStore(runtime, fromBase64url(keys.replayKey)),
    reviews: new ReviewApprovalStore(runtime),
    delivered: new ReefDeliveredStore(runtime),
  };
}

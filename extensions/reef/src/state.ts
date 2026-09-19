import { randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
// Import from defining modules, not the protocol barrel: index.js re-exports
// guard-adapters, whose provider-http graph doctor enumeration must not cold-load.
import { base64url, fromBase64url } from "../protocol/encoding.js";
import { generateIdentity } from "../protocol/identity.js";
import type { ReviewApproval, ReviewRequest } from "../protocol/pipeline.js";
import { openReefAuditStore } from "./audit-state.js";
import {
  parseReefIdentityBinding,
  REEF_REGISTRATION_IDENTITY_KEY,
  REEF_REGISTRATION_NAMESPACE,
  REEF_REGISTRATION_MAX_ENTRIES,
  type ReefIdentityBinding,
} from "./registration-state.js";
import { ReefSqliteReplayStore, REEF_REPLAY_TTL_MS } from "./replay-store.js";
import type { ReefKeys } from "./types.js";

export * from "./audit-state.js";
export * from "./registration-state.js";

export const REEF_KEYS_NAMESPACE = "identity";
export const REEF_KEYS_KEY = "keys";
export const REEF_KEYS_MAX_ENTRIES = 1;
export const REEF_KEYS_MIGRATION_NAMESPACE = "identity-migration";
export const REEF_KEYS_MIGRATION_KEY = "keys-json";
export const REEF_KEYS_MIGRATION_MAX_ENTRIES = 1;
export const REEF_DURABLE_MIGRATION_NAMESPACE = "durable-migration";
export const REEF_DURABLE_MIGRATION_KEY = "legacy-files";
export const REEF_DURABLE_MIGRATION_MAX_ENTRIES = 1;
export const REEF_REVIEWS_NAMESPACE = "reviews";
export const REEF_REVIEWS_MAX_ENTRIES = 2_000;
export const REEF_DELIVERED_NAMESPACE = "delivered";
export const REEF_DELIVERED_MAX_ENTRIES = 5_000;
export const REEF_DELIVERED_TTL_MS = REEF_REPLAY_TTL_MS;
const REEF_INBOX_CURSOR_NAMESPACE = "inbox-cursor";
const REEF_INBOX_CURSOR_KEY = "current";
const REEF_INBOX_CURSOR_MAX_ENTRIES = 1;

export type ReefReviewRecord = { review: ReviewRequest; approved?: boolean };

export type ReefIdentityMigrationRecord = {
  pending: true;
  identityBindingRequired: boolean;
};
export type ReefDurableMigrationRecord = { pending: true };

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

function assertReefIdentityMigrationComplete(runtime: PluginRuntime): void {
  const durableMigration = runtime.state.openSyncKeyedStore<ReefDurableMigrationRecord>({
    namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
    maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  if (durableMigration.lookup(REEF_DURABLE_MIGRATION_KEY)) {
    throw new Error(
      "Reef durable state migration is incomplete; repair the legacy state files and rerun openclaw doctor --fix",
    );
  }
  const migration = runtime.state.openSyncKeyedStore<ReefIdentityMigrationRecord>({
    namespace: REEF_KEYS_MIGRATION_NAMESPACE,
    maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  if (migration.lookup(REEF_KEYS_MIGRATION_KEY)) {
    throw new Error(
      "Reef identity migration is incomplete; repair the legacy identity files and rerun openclaw doctor --fix",
    );
  }
}

export async function generateAndStoreKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  assertReefIdentityMigrationComplete(runtime);
  // Key creation retains its uninterrupted native guard-and-insert path until
  // the storage owner can compare the migration and binding rows with the insert.
  const binding = parseReefIdentityBinding(
    runtime.state
      .openSyncKeyedStore<ReefIdentityBinding>({
        namespace: REEF_REGISTRATION_NAMESPACE,
        maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
        overflowPolicy: "reject-new",
      })
      .lookup(REEF_REGISTRATION_IDENTITY_KEY),
  );
  if (binding) {
    throw new Error(
      `Reef identity @${binding.handle} on ${binding.relayUrl} has no canonical keys; restore the original keys before registration`,
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
  assertReefIdentityMigrationComplete(runtime);
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

export class ReviewApprovalStore {
  readonly #store: PluginStateSyncKeyedStore<ReefReviewRecord>;
  readonly #reader: PluginStateKeyedStore<ReefReviewRecord>;
  readonly #maxEntries: number;

  constructor(
    runtime: PluginRuntime,
    maxEntries = REEF_REVIEWS_MAX_ENTRIES,
    private readonly authoritySignal?: AbortSignal,
  ) {
    this.#maxEntries = maxEntries;
    const options: OpenKeyedStoreOptions = {
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
    };
    // Mutations must remain uninterrupted after the live channel-authority check.
    this.#store = runtime.state.openSyncKeyedStore<ReefReviewRecord>(options);
    this.#reader = runtime.state.openKeyedStore<ReefReviewRecord>(options);
  }

  #makeRoomForPendingReview(): void {
    const deleteIf = this.#store.deleteIf;
    if (!deleteIf) {
      throw new Error("Reef review retention requires atomic plugin-state deleteIf");
    }
    while (true) {
      if (this.#store.count && this.#store.count() < this.#maxEntries) {
        return;
      }
      const entries = this.#store.entries();
      if (entries.length < this.#maxEntries) {
        return;
      }
      const completed = entries
        .filter((entry) => entry.value.approved !== undefined)
        .toSorted((left, right) => left.createdAt - right.createdAt)[0];
      if (!completed) {
        throw new Error("Reef pending review capacity is exhausted");
      }
      deleteIf(completed.key, (current) => current.approved !== undefined);
    }
  }

  async request(review: ReviewRequest): Promise<ReviewApproval | undefined> {
    this.authoritySignal?.throwIfAborted();
    const current = this.#store.lookup(review.approvalDigest);
    if (current?.approved !== undefined) {
      return { approved: current.approved, approvalDigest: review.approvalDigest };
    }
    if (!current) {
      this.#makeRoomForPendingReview();
    }
    this.#store.registerIfAbsent(review.approvalDigest, { review: structuredClone(review) });
    const persisted = this.#store.lookup(review.approvalDigest);
    if (!persisted) {
      throw new Error("Failed persisting Reef pending review");
    }
    return persisted?.approved === undefined
      ? undefined
      : { approved: persisted.approved, approvalDigest: review.approvalDigest };
  }

  async lookupDecision(
    approvalDigest: string,
  ): Promise<"none" | "pending" | { approved: boolean }> {
    this.authoritySignal?.throwIfAborted();
    const current = await this.#reader.lookup(approvalDigest);
    this.authoritySignal?.throwIfAborted();
    if (!current) {
      return "none";
    }
    return current.approved === undefined ? "pending" : { approved: current.approved };
  }

  async decide(digest: string, approved: boolean): Promise<ReviewRequest | undefined> {
    const update = this.#store.update;
    if (!update) {
      throw new Error("Reef review state requires atomic plugin-state updates");
    }
    let decided: ReviewRequest | undefined;
    this.authoritySignal?.throwIfAborted();
    update(digest, (current) => {
      if (!current) {
        return undefined;
      }
      decided = structuredClone(current.review);
      return { ...current, approved };
    });
    return decided;
  }

  async list(): Promise<ReviewRequest[]> {
    this.authoritySignal?.throwIfAborted();
    const entries = await this.#reader.entries();
    this.authoritySignal?.throwIfAborted();
    return entries
      .filter((entry) => entry.value.approved === undefined)
      .map((entry) => structuredClone(entry.value.review));
  }
}

export class ReefDeliveredStore {
  readonly #delivered: PluginStateKeyedStore<{ id: string }>;

  constructor(runtime: PluginRuntime, maxEntries = REEF_DELIVERED_MAX_ENTRIES) {
    this.#delivered = runtime.state.openKeyedStore<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
      // Relay redelivery is bounded by the same envelope-age contract as replay.
      // Keep markers longer than that window and fail closed at live capacity.
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
  }

  async has(id: string): Promise<boolean> {
    return (await this.#delivered.lookup(id))?.id === id;
  }

  async status(id: string): Promise<"delivered" | undefined> {
    return (await this.#delivered.lookup(id))?.id === id ? "delivered" : undefined;
  }

  async confirm(id: string): Promise<void> {
    const inserted = await this.#delivered.registerIfAbsent(id, { id });
    if (!inserted && (await this.#delivered.lookup(id))?.id !== id) {
      throw new Error("Failed persisting Reef delivered marker");
    }
  }

  async add(id: string): Promise<void> {
    await this.confirm(id);
  }
}

type ReefInboxCursorRecord = ReefIdentityBinding & { cursor: number };

function parseReefInboxCursorRecord(value: unknown): ReefInboxCursorRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Partial<ReefInboxCursorRecord>;
  return typeof record.handle === "string" &&
    record.handle.length > 0 &&
    typeof record.relayUrl === "string" &&
    record.relayUrl.length > 0 &&
    Number.isSafeInteger(record.cursor) &&
    (record.cursor ?? -1) >= 0
    ? { handle: record.handle, relayUrl: record.relayUrl, cursor: record.cursor! }
    : undefined;
}

/** Durable relay progress for the single Reef identity bound to this state DB. */
export class ReefInboxCursorStore {
  readonly #store: PluginStateKeyedStore<ReefInboxCursorRecord>;
  readonly #openLegacy: () => PluginStateSyncKeyedStore<ReefInboxCursorRecord>;

  constructor(
    runtime: PluginRuntime,
    readonly binding: ReefIdentityBinding,
  ) {
    const options = {
      namespace: REEF_INBOX_CURSOR_NAMESPACE,
      maxEntries: REEF_INBOX_CURSOR_MAX_ENTRIES,
      overflowPolicy: "reject-new" as const,
    };
    this.#store = runtime.state.openKeyedStore<ReefInboxCursorRecord>(options);
    this.#openLegacy = () => runtime.state.openSyncKeyedStore<ReefInboxCursorRecord>(options);
  }

  async load(): Promise<number> {
    const value = await this.#store.lookup(REEF_INBOX_CURSOR_KEY);
    if (value === undefined) {
      return 0;
    }
    return this.#requireBoundRecord(value).cursor;
  }

  async advance(cursor: number): Promise<void> {
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("invalid Reef inbox cursor");
    }
    const { observe, compareAndApply } = this.#store;
    if (observe && compareAndApply) {
      let observation = await observe(REEF_INBOX_CURSOR_KEY);
      for (;;) {
        let existing: ReefInboxCursorRecord | undefined;
        try {
          existing =
            observation.value === undefined
              ? undefined
              : this.#requireBoundRecord(observation.value);
        } catch (error) {
          // Refuse only a still-current invalid row; a concurrent repair must
          // be revalidated before publishing the observed domain error.
          const result = await compareAndApply(REEF_INBOX_CURSOR_KEY, observation.comparison, {
            operation: "update",
            action: "keep",
          });
          if (result.status !== "conflict") {
            throw error;
          }
          observation = result.current;
          continue;
        }
        const value = existing
          ? cursor > existing.cursor
            ? { ...existing, cursor }
            : existing
          : { ...this.binding, cursor };
        const result = await compareAndApply(REEF_INBOX_CURSOR_KEY, observation.comparison, {
          operation: "update",
          action: "set",
          value,
        });
        if (result.status !== "conflict") {
          break;
        }
        observation = result.current;
      }
      const persisted = await this.#store.lookup(REEF_INBOX_CURSOR_KEY);
      if (!persisted || this.#requireBoundRecord(persisted).cursor < cursor) {
        throw new Error("failed persisting Reef inbox cursor");
      }
      return;
    }
    // Older supported hosts keep the original atomic update. Select this path
    // before awaiting; worker failures must never retry through native storage.
    const store = this.#openLegacy();
    const update = store.update;
    if (!update) {
      throw new Error("Reef inbox cursor requires atomic plugin-state updates");
    }
    update(REEF_INBOX_CURSOR_KEY, (current) => {
      if (current === undefined) {
        return { ...this.binding, cursor };
      }
      const existing = this.#requireBoundRecord(current);
      return cursor > existing.cursor ? { ...existing, cursor } : existing;
    });
    const persisted = store.lookup(REEF_INBOX_CURSOR_KEY);
    if (!persisted || this.#requireBoundRecord(persisted).cursor < cursor) {
      throw new Error("failed persisting Reef inbox cursor");
    }
  }

  #requireBoundRecord(value: unknown): ReefInboxCursorRecord {
    const record = parseReefInboxCursorRecord(value);
    if (!record) {
      throw new Error("invalid Reef inbox cursor state");
    }
    if (record.handle !== this.binding.handle || record.relayUrl !== this.binding.relayUrl) {
      throw new Error("Reef inbox cursor belongs to a different identity");
    }
    return record;
  }
}

export function openStores(
  runtime: PluginRuntime,
  keys: ReefKeys,
  options: {
    auditMaxEntries?: number;
    replayMaxEntries?: number;
    deliveredMaxEntries?: number;
    authoritySignal?: AbortSignal;
  } = {},
) {
  assertReefIdentityMigrationComplete(runtime);
  return {
    audit: openReefAuditStore(runtime, fromBase64url(keys.auditKey), options.auditMaxEntries),
    replay: new ReefSqliteReplayStore(
      runtime,
      fromBase64url(keys.replayKey),
      randomBytes,
      options.replayMaxEntries,
    ),
    reviews: new ReviewApprovalStore(runtime, undefined, options.authoritySignal),
    delivered: new ReefDeliveredStore(runtime, options.deliveredMaxEntries),
  };
}

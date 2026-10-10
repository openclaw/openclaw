import { randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
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

function openKeysStore(runtime: PluginRuntime): PluginStateKeyedStore<ReefKeys, 2> {
  return runtime.state.openKeyedStoreV2<ReefKeys>({
    namespace: REEF_KEYS_NAMESPACE,
    maxEntries: REEF_KEYS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

async function observeReefIdentityMigration(runtime: PluginRuntime) {
  const durableMigration = runtime.state.openKeyedStoreV2<ReefDurableMigrationRecord>({
    namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
    maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  const durable = await durableMigration.observe(REEF_DURABLE_MIGRATION_KEY);
  if (durable.value) {
    throw new Error(
      "Reef durable state migration is incomplete; repair the legacy state files and rerun openclaw doctor --fix",
    );
  }
  const migration = runtime.state.openKeyedStoreV2<ReefIdentityMigrationRecord>({
    namespace: REEF_KEYS_MIGRATION_NAMESPACE,
    maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  const identity = await migration.observe(REEF_KEYS_MIGRATION_KEY);
  if (identity.value) {
    throw new Error(
      "Reef identity migration is incomplete; repair the legacy identity files and rerun openclaw doctor --fix",
    );
  }
  return [
    {
      namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
      key: REEF_DURABLE_MIGRATION_KEY,
      comparison: durable.comparison,
    },
    {
      namespace: REEF_KEYS_MIGRATION_NAMESPACE,
      key: REEF_KEYS_MIGRATION_KEY,
      comparison: identity.comparison,
    },
  ];
}

export async function generateAndStoreKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  const bindings = runtime.state.openKeyedStoreV2<ReefIdentityBinding>({
    namespace: REEF_REGISTRATION_NAMESPACE,
    maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  const store = openKeysStore(runtime);
  const identity = generateIdentity();
  const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
  const keys: ReefKeys = {
    ...identity,
    auditKey: base64url(random(32)),
    replayKey: base64url(random(32)),
    keyEpoch: 1,
  };
  for (;;) {
    const conditions = await observeReefIdentityMigration(runtime);
    const bindingObservation = await bindings.observe(REEF_REGISTRATION_IDENTITY_KEY);
    const binding = parseReefIdentityBinding(bindingObservation.value);
    if (binding) {
      throw new Error(
        `Reef identity @${binding.handle} on ${binding.relayUrl} has no canonical keys; restore the original keys before registration`,
      );
    }
    const observed = await store.observe(REEF_KEYS_KEY);
    if (observed.value !== undefined) {
      throw new Error("Reef keys already exist in plugin state");
    }
    const result = await store.compareAndApply(
      REEF_KEYS_KEY,
      observed.comparison,
      { operation: "update", action: "set", value: keys },
      {
        conditions: [
          ...conditions,
          {
            namespace: REEF_REGISTRATION_NAMESPACE,
            key: REEF_REGISTRATION_IDENTITY_KEY,
            comparison: bindingObservation.comparison,
          },
        ],
      },
    );
    if (result.status !== "conflict") {
      return keys;
    }
  }
}

export async function loadKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  await observeReefIdentityMigration(runtime);
  const value = await openKeysStore(runtime).lookup(REEF_KEYS_KEY);
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
  readonly #store: PluginStateKeyedStore<ReefReviewRecord, 2>;
  readonly #openStore: (assertCurrent?: () => void) => PluginStateKeyedStore<ReefReviewRecord, 2>;
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
    this.#openStore = (assertCurrent) =>
      runtime.state.openKeyedStoreV2<ReefReviewRecord>(options, {
        assertCurrent: () => {
          this.authoritySignal?.throwIfAborted();
          assertCurrent?.();
        },
      });
    this.#store = this.#openStore();
  }

  async #makeRoomForPendingReview(approvalDigest: string): Promise<void> {
    while (true) {
      if ((await this.#store.count()) < this.#maxEntries) {
        return;
      }
      const entries = await this.#store.entries();
      if (entries.length < this.#maxEntries) {
        return;
      }
      const completed = entries
        .filter((entry) => entry.value.approved !== undefined)
        .toSorted((left, right) => left.createdAt - right.createdAt)[0];
      if (!completed) {
        if (await this.#store.lookup(approvalDigest)) {
          return;
        }
        throw new Error("Reef pending review capacity is exhausted");
      }
      const observation = await this.#store.observe(completed.key);
      if (observation.value?.approved !== undefined) {
        await this.#store.compareAndApply(completed.key, observation.comparison, {
          operation: "delete",
          action: "delete",
        });
      }
    }
  }

  async request(review: ReviewRequest): Promise<ReviewApproval | undefined> {
    this.authoritySignal?.throwIfAborted();
    const current = await this.#store.lookup(review.approvalDigest);
    if (current?.approved !== undefined) {
      return { approved: current.approved, approvalDigest: review.approvalDigest };
    }
    if (!current) {
      await this.#makeRoomForPendingReview(review.approvalDigest);
    }
    await this.#store.registerIfAbsent(review.approvalDigest, { review: structuredClone(review) });
    const persisted = await this.#store.lookup(review.approvalDigest);
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
    const current = await this.#store.lookup(approvalDigest);
    this.authoritySignal?.throwIfAborted();
    if (!current) {
      return "none";
    }
    return current.approved === undefined ? "pending" : { approved: current.approved };
  }

  async decide(
    digest: string,
    approved: boolean,
    assertOwnerCurrent?: () => void,
  ): Promise<ReviewRequest | undefined> {
    const store = this.#openStore(assertOwnerCurrent);
    let observation = await store.observe(digest);
    for (;;) {
      if (!observation.value) {
        return undefined;
      }
      const result = await store.compareAndApply(digest, observation.comparison, {
        operation: "update",
        action: "set",
        value: { ...observation.value, approved },
      });
      if (result.status !== "conflict") {
        return structuredClone(observation.value.review);
      }
      observation = result.current;
    }
  }

  async list(): Promise<ReviewRequest[]> {
    this.authoritySignal?.throwIfAborted();
    const entries = await this.#store.entries();
    this.authoritySignal?.throwIfAborted();
    return entries
      .filter((entry) => entry.value.approved === undefined)
      .map((entry) => structuredClone(entry.value.review));
  }
}

export class ReefDeliveredStore {
  readonly #delivered: PluginStateKeyedStore<{ id: string }, 2>;

  constructor(runtime: PluginRuntime, maxEntries = REEF_DELIVERED_MAX_ENTRIES) {
    this.#delivered = runtime.state.openKeyedStoreV2<{ id: string }>({
      namespace: REEF_DELIVERED_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
      // Relay redelivery is bounded by the same envelope-age contract as replay.
      // Keep markers longer than that window and fail closed at live capacity.
      defaultTtlMs: REEF_DELIVERED_TTL_MS,
    });
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
  readonly #store: PluginStateKeyedStore<ReefInboxCursorRecord, 2>;

  constructor(
    runtime: PluginRuntime,
    readonly binding: ReefIdentityBinding,
  ) {
    const options = {
      namespace: REEF_INBOX_CURSOR_NAMESPACE,
      maxEntries: REEF_INBOX_CURSOR_MAX_ENTRIES,
      overflowPolicy: "reject-new" as const,
    };
    this.#store = runtime.state.openKeyedStoreV2<ReefInboxCursorRecord>(options);
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
    let observation = await observe(REEF_INBOX_CURSOR_KEY);
    for (;;) {
      let existing: ReefInboxCursorRecord | undefined;
      try {
        existing =
          observation.value === undefined ? undefined : this.#requireBoundRecord(observation.value);
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

export async function openStores(
  runtime: PluginRuntime,
  keys: ReefKeys,
  options: {
    auditMaxEntries?: number;
    replayMaxEntries?: number;
    deliveredMaxEntries?: number;
    authoritySignal?: AbortSignal;
  } = {},
) {
  await observeReefIdentityMigration(runtime);
  return {
    audit: await openReefAuditStore(runtime, fromBase64url(keys.auditKey), options.auditMaxEntries),
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

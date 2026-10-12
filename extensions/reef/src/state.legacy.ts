import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { base64url } from "../protocol/encoding.js";
import { generateIdentity } from "../protocol/identity.js";
import type { ReviewApproval, ReviewRequest } from "../protocol/pipeline.js";
import {
  parseReefIdentityBinding,
  REEF_REGISTRATION_IDENTITY_KEY,
  REEF_REGISTRATION_NAMESPACE,
  REEF_REGISTRATION_MAX_ENTRIES,
  type ReefIdentityBinding,
} from "./registration-state.js";
import {
  parseReefKeys,
  REEF_KEYS_NAMESPACE,
  REEF_KEYS_KEY,
  REEF_KEYS_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
  REEF_KEYS_MIGRATION_KEY,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_DURABLE_MIGRATION_NAMESPACE,
  REEF_DURABLE_MIGRATION_KEY,
  REEF_DURABLE_MIGRATION_MAX_ENTRIES,
  REEF_REVIEWS_NAMESPACE,
  REEF_REVIEWS_MAX_ENTRIES,
  type ReefReviewRecord,
  type ReefIdentityMigrationRecord,
  type ReefDurableMigrationRecord,
} from "./state-format.js";
import type { ReefKeys } from "./types.js";

// Released hosts without worker operations retain their original native owner until
// an approved minimum host version guarantees the operation capability.
function openKeysStore(runtime: PluginRuntime): PluginStateSyncKeyedStore<ReefKeys> {
  return runtime.state.openSyncKeyedStore<ReefKeys>({
    namespace: REEF_KEYS_NAMESPACE,
    maxEntries: REEF_KEYS_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
}

export function assertLegacyReefIdentityMigrationComplete(runtime: PluginRuntime): void {
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

export async function generateAndStoreLegacyKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  assertLegacyReefIdentityMigrationComplete(runtime);
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

export async function loadLegacyKeys(runtime: PluginRuntime): Promise<ReefKeys> {
  assertLegacyReefIdentityMigrationComplete(runtime);
  const value = openKeysStore(runtime).lookup(REEF_KEYS_KEY);
  if (!value) {
    throw Object.assign(new Error("Reef keys are missing from plugin state"), { code: "ENOENT" });
  }
  return parseReefKeys(value);
}

export class LegacyReviewApprovalStore {
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

  async decide(
    digest: string,
    approved: boolean,
    assertOwnerCurrent?: () => void,
  ): Promise<ReviewRequest | undefined> {
    const update = this.#store.update;
    if (!update) {
      throw new Error("Reef review state requires atomic plugin-state updates");
    }
    let decided: ReviewRequest | undefined;
    this.authoritySignal?.throwIfAborted();
    assertOwnerCurrent?.();
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

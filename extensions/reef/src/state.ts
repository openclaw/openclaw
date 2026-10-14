import { randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
// Import from defining modules, not the protocol barrel: index.js re-exports
// guard-adapters, whose provider-http graph doctor enumeration must not cold-load.
import { fromBase64url } from "../protocol/encoding.js";
import type { ReviewApproval, ReviewRequest } from "../protocol/pipeline.js";
import { openReefAuditStore } from "./audit-state.js";
import {
  REEF_REGISTRATION_NAMESPACE,
  REEF_REGISTRATION_MAX_ENTRIES,
  type ReefIdentityBinding,
} from "./registration-state.js";
import { ReefSqliteReplayStore, REEF_REPLAY_TTL_MS } from "./replay-store.js";
import {
  REEF_KEYS_NAMESPACE,
  REEF_KEYS_MAX_ENTRIES,
  REEF_KEYS_MIGRATION_NAMESPACE,
  REEF_KEYS_MIGRATION_MAX_ENTRIES,
  REEF_DURABLE_MIGRATION_NAMESPACE,
  REEF_DURABLE_MIGRATION_MAX_ENTRIES,
  REEF_REVIEWS_NAMESPACE,
  REEF_REVIEWS_MAX_ENTRIES,
  type ReefReviewRecord,
  type ReefIdentityMigrationRecord,
  type ReefDurableMigrationRecord,
} from "./state-format.js";
import {
  REEF_INBOX_CURSOR_KEY,
  requireReefInboxCursorRecord,
  type ReefInboxCursorRecord,
  type ReefStateOperations,
} from "./state-operation.js";
import {
  assertLegacyReefIdentityMigrationComplete,
  generateAndStoreLegacyKeys,
  loadLegacyKeys,
  LegacyReviewApprovalStore,
} from "./state.legacy.js";
import type { ReefKeys } from "./types.js";

export * from "./audit-state.js";
export * from "./registration-state.js";
export * from "./state-format.js";

export const REEF_DELIVERED_NAMESPACE = "delivered";
export const REEF_DELIVERED_MAX_ENTRIES = 5_000;
export const REEF_DELIVERED_TTL_MS = REEF_REPLAY_TTL_MS;
const REEF_INBOX_CURSOR_NAMESPACE = "inbox-cursor";
const REEF_INBOX_CURSOR_MAX_ENTRIES = 1;

const stateOperationHandler = {
  moduleName: "state-operation-api.js",
  exportName: "runReefStateOperation",
};

function openIdentityState(runtime: PluginRuntime, assertCurrent?: () => void) {
  const stores = [
    runtime.state.openKeyedStore<ReefDurableMigrationRecord>({
      namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
      maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStore<ReefIdentityMigrationRecord>({
      namespace: REEF_KEYS_MIGRATION_NAMESPACE,
      maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStore<ReefKeys>({
      namespace: REEF_KEYS_NAMESPACE,
      maxEntries: REEF_KEYS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStore<ReefIdentityBinding>({
      namespace: REEF_REGISTRATION_NAMESPACE,
      maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
  ];
  return stores[0]!.createOperation?.<ReefStateOperations>(
    stores,
    stateOperationHandler,
    assertCurrent ? { assertCurrent } : undefined,
  );
}

export async function generateAndStoreKeys(
  runtime: PluginRuntime,
  assertCurrent?: () => void,
): Promise<ReefKeys> {
  const state = openIdentityState(runtime, assertCurrent);
  if (!state) {
    assertCurrent?.();
    return generateAndStoreLegacyKeys(runtime);
  }
  const receipt = await state.execute(
    { type: "identity.generate", input: undefined },
    { writeStores: [2] },
  );
  return receipt.value;
}

export async function loadKeys(
  runtime: PluginRuntime,
  assertCurrent?: () => void,
): Promise<ReefKeys> {
  const state = openIdentityState(runtime, assertCurrent);
  if (!state) {
    assertCurrent?.();
    return loadLegacyKeys(runtime);
  }
  const receipt = await state.execute(
    { type: "identity.load", input: undefined },
    { writeStores: [], watchStores: [0, 1, 2], missingValue: undefined },
  );
  receipt.assertCurrent();
  if (!receipt.value) {
    throw Object.assign(new Error("Reef keys are missing from plugin state"), { code: "ENOENT" });
  }
  return receipt.value;
}

type ReefReviewOperationState = {
  store: PluginStateKeyedStore<ReefReviewRecord>;
  maxEntries: number;
};
const reviewOperationStates = new WeakMap<ReviewApprovalStore, ReefReviewOperationState>();

export function getReefReviewOperationState(
  reviews: ReviewApprovalStore,
): ReefReviewOperationState | undefined {
  return reviewOperationStates.get(reviews);
}

export class ReviewApprovalStore {
  readonly #store: PluginStateKeyedStore<ReefReviewRecord>;
  readonly #maxEntries: number;
  readonly #legacy?: LegacyReviewApprovalStore;

  constructor(
    runtime: PluginRuntime,
    maxEntries = REEF_REVIEWS_MAX_ENTRIES,
    private readonly authoritySignal?: AbortSignal,
  ) {
    this.#maxEntries = maxEntries;
    this.#store = runtime.state.openKeyedStore<ReefReviewRecord>({
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
    });
    if (!this.#store.createOperation) {
      this.#legacy = new LegacyReviewApprovalStore(runtime, maxEntries, authoritySignal);
    } else {
      reviewOperationStates.set(this, { store: this.#store, maxEntries });
    }
  }

  #operation(assertOwnerCurrent?: () => void) {
    return this.#store.createOperation!<ReefStateOperations>([this.#store], stateOperationHandler, {
      assertCurrent: () => {
        this.authoritySignal?.throwIfAborted();
        assertOwnerCurrent?.();
      },
    });
  }

  async request(review: ReviewRequest): Promise<ReviewApproval | undefined> {
    if (this.#legacy) {
      return this.#legacy.request(review);
    }
    const captured = structuredClone(review);
    const operation = this.#operation();
    const receipt = await operation.execute(
      { type: "review.request", input: { review: captured, maxEntries: this.#maxEntries } },
      { writeStores: [0] },
    );
    return receipt.value;
  }

  async lookupDecision(
    approvalDigest: string,
  ): Promise<"none" | "pending" | { approved: boolean }> {
    if (this.#legacy) {
      return this.#legacy.lookupDecision(approvalDigest);
    }
    const operation = this.#operation();
    const receipt = await operation.execute(
      { type: "review.lookup", input: { digest: approvalDigest } },
      { writeStores: [], watchStores: [0], missingValue: "none" },
    );
    receipt.assertCurrent();
    return receipt.value;
  }

  async decide(
    digest: string,
    approved: boolean,
    assertOwnerCurrent?: () => void,
  ): Promise<ReviewRequest | undefined> {
    if (this.#legacy) {
      return this.#legacy.decide(digest, approved, assertOwnerCurrent);
    }
    const operation = this.#operation(assertOwnerCurrent);
    const receipt = await operation.execute(
      { type: "review.decide", input: { digest, approved } },
      { writeStores: [0] },
    );
    return receipt.value;
  }

  async list(): Promise<ReviewRequest[]> {
    if (this.#legacy) {
      return this.#legacy.list();
    }
    const operation = this.#operation();
    const receipt = await operation.execute(
      { type: "review.list", input: undefined },
      { writeStores: [], watchStores: [0], missingValue: [] },
    );
    receipt.assertCurrent();
    return receipt.value;
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

/** Durable relay progress for the single Reef identity bound to this state DB. */
export class ReefInboxCursorStore {
  readonly #store: PluginStateKeyedStore<ReefInboxCursorRecord>;
  readonly #openLegacy: () => PluginStateSyncKeyedStore<ReefInboxCursorRecord>;
  readonly #binding: ReefIdentityBinding;

  constructor(
    runtime: PluginRuntime,
    binding: ReefIdentityBinding,
    private readonly authoritySignal?: AbortSignal,
  ) {
    this.#binding = { ...binding };
    const options = {
      namespace: REEF_INBOX_CURSOR_NAMESPACE,
      maxEntries: REEF_INBOX_CURSOR_MAX_ENTRIES,
      overflowPolicy: "reject-new" as const,
    };
    this.#store = runtime.state.openKeyedStore<ReefInboxCursorRecord>(options);
    this.#openLegacy = () => runtime.state.openSyncKeyedStore<ReefInboxCursorRecord>(options);
  }

  #operation() {
    return this.#store.createOperation?.<ReefStateOperations>(
      [this.#store],
      stateOperationHandler,
      { assertCurrent: () => this.authoritySignal?.throwIfAborted() },
    );
  }

  async load(): Promise<number> {
    this.authoritySignal?.throwIfAborted();
    const operation = this.#operation();
    if (operation) {
      const receipt = await operation.execute(
        { type: "cursor.load", input: this.#binding },
        { writeStores: [], watchStores: [0], missingValue: 0 },
      );
      receipt.assertCurrent();
      return receipt.value;
    }
    const value = await this.#store.lookup(REEF_INBOX_CURSOR_KEY);
    this.authoritySignal?.throwIfAborted();
    return value === undefined ? 0 : requireReefInboxCursorRecord(value, this.#binding).cursor;
  }

  async advance(cursor: number): Promise<void> {
    this.authoritySignal?.throwIfAborted();
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("invalid Reef inbox cursor");
    }
    const operation = this.#operation();
    if (operation) {
      await operation.execute(
        { type: "cursor.advance", input: { ...this.#binding, cursor } },
        { writeStores: [0] },
      );
      return;
    }
    // Released hosts without operation commands retain their atomic native update.
    const store = this.#openLegacy();
    const update = store.update;
    if (!update) {
      throw new Error("Reef inbox cursor requires atomic plugin-state updates");
    }
    this.authoritySignal?.throwIfAborted();
    update.call(store, REEF_INBOX_CURSOR_KEY, (current) => {
      if (current === undefined) {
        return { ...this.#binding, cursor };
      }
      const existing = requireReefInboxCursorRecord(current, this.#binding);
      return cursor > existing.cursor ? { ...existing, cursor } : existing;
    });
    const persisted = store.lookup(REEF_INBOX_CURSOR_KEY);
    if (!persisted || requireReefInboxCursorRecord(persisted, this.#binding).cursor < cursor) {
      throw new Error("failed persisting Reef inbox cursor");
    }
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
  const { authoritySignal } = options;
  const assertCurrent = () => authoritySignal?.throwIfAborted();
  const state = openIdentityState(runtime, assertCurrent);
  if (!state) {
    assertCurrent();
    assertLegacyReefIdentityMigrationComplete(runtime);
  }
  const stores = {
    audit: openReefAuditStore(
      runtime,
      fromBase64url(keys.auditKey),
      options.auditMaxEntries,
      options.authoritySignal,
    ),
    replay: new ReefSqliteReplayStore(
      runtime,
      fromBase64url(keys.replayKey),
      randomBytes,
      options.replayMaxEntries,
    ),
    reviews: new ReviewApprovalStore(runtime, undefined, options.authoritySignal),
    delivered: new ReefDeliveredStore(runtime, options.deliveredMaxEntries),
  };
  if (state) {
    const receipt = await state.execute(
      { type: "identity.admit", input: undefined },
      { writeStores: [], watchStores: [0, 1], missingValue: undefined },
    );
    receipt.assertCurrent();
  }
  return stores;
}

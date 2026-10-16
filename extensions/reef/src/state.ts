import { randomBytes } from "@noble/hashes/utils.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
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
import type { ReefInboxCursorRecord, ReefStateOperations } from "./state-operation.js";
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
    runtime.state.openKeyedStoreV2<ReefDurableMigrationRecord>({
      namespace: REEF_DURABLE_MIGRATION_NAMESPACE,
      maxEntries: REEF_DURABLE_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStoreV2<ReefIdentityMigrationRecord>({
      namespace: REEF_KEYS_MIGRATION_NAMESPACE,
      maxEntries: REEF_KEYS_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStoreV2<ReefKeys>({
      namespace: REEF_KEYS_NAMESPACE,
      maxEntries: REEF_KEYS_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
    runtime.state.openKeyedStoreV2<ReefIdentityBinding>({
      namespace: REEF_REGISTRATION_NAMESPACE,
      maxEntries: REEF_REGISTRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    }),
  ];
  return stores[0]!.createOperation!<ReefStateOperations>(
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
  store: PluginStateKeyedStore<ReefReviewRecord, 2>;
  maxEntries: number;
};
const reviewOperationStates = new WeakMap<ReviewApprovalStore, ReefReviewOperationState>();

export function getReefReviewOperationState(
  reviews: ReviewApprovalStore,
): ReefReviewOperationState | undefined {
  return reviewOperationStates.get(reviews);
}

export class ReviewApprovalStore {
  readonly #store: PluginStateKeyedStore<ReefReviewRecord, 2>;
  readonly #maxEntries: number;

  constructor(
    runtime: PluginRuntime,
    maxEntries = REEF_REVIEWS_MAX_ENTRIES,
    private readonly authoritySignal?: AbortSignal,
  ) {
    this.#maxEntries = maxEntries;
    this.#store = runtime.state.openKeyedStoreV2<ReefReviewRecord>({
      namespace: REEF_REVIEWS_NAMESPACE,
      maxEntries,
      overflowPolicy: "reject-new",
    });
    reviewOperationStates.set(this, { store: this.#store, maxEntries });
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
    const operation = this.#operation();
    const receipt = await operation.execute(
      { type: "review.request", input: { review, maxEntries: this.#maxEntries } },
      { writeStores: [0] },
    );
    return receipt.value;
  }

  async lookupDecision(
    approvalDigest: string,
  ): Promise<"none" | "pending" | { approved: boolean }> {
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
    const operation = this.#operation(assertOwnerCurrent);
    const receipt = await operation.execute(
      { type: "review.decide", input: { digest, approved } },
      { writeStores: [0] },
    );
    return receipt.value;
  }

  async list(): Promise<ReviewRequest[]> {
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

/** Durable relay progress for the single Reef identity bound to this state DB. */
export class ReefInboxCursorStore {
  readonly #store: PluginStateKeyedStore<ReefInboxCursorRecord, 2>;
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
    this.#store = runtime.state.openKeyedStoreV2<ReefInboxCursorRecord>(options);
  }

  #operation() {
    return this.#store.createOperation!<ReefStateOperations>([this.#store], stateOperationHandler, {
      assertCurrent: () => this.authoritySignal?.throwIfAborted(),
    });
  }

  async load(): Promise<number> {
    this.authoritySignal?.throwIfAborted();
    const operation = this.#operation();
    const receipt = await operation.execute(
      { type: "cursor.load", input: this.#binding },
      { writeStores: [], watchStores: [0], missingValue: 0 },
    );
    receipt.assertCurrent();
    return receipt.value;
  }

  async advance(cursor: number): Promise<void> {
    this.authoritySignal?.throwIfAborted();
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error("invalid Reef inbox cursor");
    }
    const operation = this.#operation();
    await operation.execute(
      { type: "cursor.advance", input: { ...this.#binding, cursor } },
      { writeStores: [0] },
    );
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
  const receipt = await state.execute(
    { type: "identity.admit", input: undefined },
    { writeStores: [], watchStores: [0, 1], missingValue: undefined },
  );
  receipt.assertCurrent();
  return stores;
}

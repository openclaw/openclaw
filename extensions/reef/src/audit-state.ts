import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type {
  PluginStateKeyedStore,
  PluginStateOperation,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import type { AuditEntry, AuditStore } from "../protocol/audit.js";
import {
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_MAX_ENTRIES,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state-format.js";
import type {
  ReefAuditAppendEvent,
  ReefAuditOperationConfig,
  ReefAuditOperations,
} from "./audit-state-operation.js";

export {
  REEF_AUDIT_NAMESPACE,
  REEF_AUDIT_HEAD_NAMESPACE,
  REEF_AUDIT_HEAD_KEY,
  REEF_AUDIT_MAX_ENTRIES,
  REEF_AUDIT_STORE_MAX_ENTRIES,
  REEF_AUDIT_HEAD_MAX_ENTRIES,
  REEF_AUDIT_MIGRATION_NAMESPACE,
  REEF_AUDIT_MIGRATION_KEY,
  REEF_AUDIT_MIGRATION_MAX_ENTRIES,
  parseReefAuditHead,
  reefAuditEntryKey,
  verifyReefAuditWindow,
  type ReefAuditHeadRecord,
  type ReefAuditStateRecord,
} from "./audit-state-format.js";

export interface ReefAuditStore extends AuditStore {
  appendEvents(events: readonly ReefAuditAppendEvent[]): Promise<AuditEntry[]>;
}

export type ReefAuditOperationState = {
  head: PluginStateKeyedStore<ReefAuditHeadRecord, 2>;
  migration: PluginStateKeyedStore<{ pending: true }, 2>;
  entries: PluginStateKeyedStore<ReefAuditStateRecord, 2>;
  auditKey: Uint8Array;
  maxEntries: number;
};

const auditOperationHandler = {
  moduleName: "audit-state-operation-api.js",
  exportName: "executeReefAuditOperation",
};

class ReefSqliteAuditStore implements ReefAuditStore {
  readonly operationState: ReefAuditOperationState;
  readonly #operation: PluginStateOperation<ReefAuditOperations>;
  readonly #config: ReefAuditOperationConfig;

  constructor(
    runtime: PluginRuntime,
    auditKey: Uint8Array,
    head: PluginStateKeyedStore<ReefAuditHeadRecord, 2>,
    maxEntries = REEF_AUDIT_MAX_ENTRIES,
    authoritySignal?: AbortSignal,
  ) {
    if (auditKey.length !== 32) {
      throw new Error("audit key must be 32 bytes");
    }
    const migration = runtime.state.openKeyedStoreV2<{ pending: true }>({
      namespace: REEF_AUDIT_MIGRATION_NAMESPACE,
      maxEntries: REEF_AUDIT_MIGRATION_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });
    const entries = runtime.state.openKeyedStoreV2<ReefAuditStateRecord>({
      namespace: REEF_AUDIT_NAMESPACE,
      maxEntries: maxEntries + 1,
      overflowPolicy: "reject-new",
    });
    this.operationState = { head, migration, entries, auditKey: auditKey.slice(), maxEntries };
    this.#config = {
      head: 0,
      migration: 1,
      entries: 2,
      auditKey: this.operationState.auditKey,
      maxEntries,
    };
    this.#operation = head.createOperation!<ReefAuditOperations>(
      [head, migration, entries],
      auditOperationHandler,
      { assertCurrent: () => authoritySignal?.throwIfAborted() },
    );
  }

  async appendEvent(
    type: string,
    payload: unknown,
    ts = Math.floor(Date.now() / 1000),
  ): Promise<AuditEntry> {
    return (await this.appendEvents([{ type, payload, ts }]))[0]!;
  }

  async appendEvents(events: readonly ReefAuditAppendEvent[]): Promise<AuditEntry[]> {
    // Submit before yielding: the shared owner preserves FIFO across audit handles.
    const result = await this.#operation.execute(
      { type: "append", input: { ...this.#config, events: structuredClone(events) } },
      { writeStores: [this.#config.head, this.#config.entries] },
    );
    // A lost acknowledgement propagates; accepted writes are never replayed.
    return result.value;
  }

  async entries(): Promise<AuditEntry[]> {
    const result = await this.#operation.execute(
      { type: "entries", input: this.#config },
      { writeStores: [], missingValue: [] },
    );
    return result.value;
  }
}

export function getReefAuditOperationState(audit: AuditStore): ReefAuditOperationState | undefined {
  if (!(audit instanceof ReefSqliteAuditStore)) {
    return undefined;
  }
  return { ...audit.operationState, auditKey: audit.operationState.auditKey.slice() };
}

export function openReefAuditStore(
  runtime: PluginRuntime,
  auditKey: Uint8Array,
  maxEntries?: number,
  authoritySignal?: AbortSignal,
): ReefAuditStore {
  const head = runtime.state.openKeyedStoreV2<ReefAuditHeadRecord>({
    namespace: REEF_AUDIT_HEAD_NAMESPACE,
    maxEntries: REEF_AUDIT_HEAD_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  return new ReefSqliteAuditStore(runtime, auditKey, head, maxEntries, authoritySignal);
}

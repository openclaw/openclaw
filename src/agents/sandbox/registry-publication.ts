import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import {
  createSqliteCommitReceipt,
  hasSqliteCommitReceiptCoverage,
  type SqliteCommitReceipt,
  type SqliteCommitSource,
  type SqliteCommittedFact,
} from "../../infra/sqlite-commit-receipt.js";
import {
  publishSqliteCommittedState,
  stageSqliteCommittedPublication,
  stageSqliteTransactionState,
} from "../../infra/sqlite-post-commit.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../../shared/listeners.js";
import { readTrackedStateDatabaseIdentity } from "../../state/openclaw-state-db-handle.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";

type RegistryRow = Selectable<DB["sandbox_registry_entries"]>;
type Receipt = SqliteCommitReceipt<RegistryRow>;
type Change = { key: string; fact: SqliteCommittedFact<RegistryRow> };
type FactChange =
  | Receipt
  | { kind: "unknown"; identity: string | symbol }
  | { kind: "pending"; identity: string; operation: object }
  | { kind: "settled"; identity: string; operation: object; outcome: "published" | "unknown" };

const state = resolveGlobalSingleton(Symbol.for("openclaw.sandboxRegistryPublication"), () => ({
  sources: new WeakMap<DatabaseSync, SqliteCommitSource>(),
  capture: new AsyncLocalStorage<Change[]>(),
  installingFacts: 0,
  facts: new Set<(change: FactChange) => void>(),
}));

function receiptFor(database: DatabaseSync, changes: readonly Change[]): Receipt {
  let source = state.sources.get(database);
  if (!source) {
    source = {
      identity: readTrackedStateDatabaseIdentity(database)?.key ?? Symbol("sandbox-registry"),
      incarnation: randomUUID(),
    };
    state.sources.set(database, source);
  }
  const facts = new Map(changes.map(({ key, fact }) => [key, fact]));
  return createSqliteCommitReceipt({
    source,
    domain: "sandbox-registry",
    keys: [...facts.keys()],
    readFact: (key) => facts.get(key)!,
  });
}

function installFacts(change: FactChange): void {
  const failures: unknown[] = [];
  state.installingFacts++;
  try {
    notifyListeners(state.facts, change, (error) => failures.push(error));
  } finally {
    state.installingFacts--;
  }
  if (failures.length) {
    throw new AggregateError(failures, "Sandbox registry fact installation failed");
  }
}

function publication(receipt: Receipt) {
  let installed = receipt;
  return {
    installFacts: () => installFacts(installed),
    invalidate() {
      installed = {
        ...receipt,
        facts: new Map([...receipt.facts.keys()].map((key) => [key, { kind: "unknown" }])),
      };
      installFacts(installed);
    },
    notify() {},
  };
}

/** Typed kernels publish rows; raw SQL/trigger writers remain incomplete and retain live guards. */
export const sandboxRegistryPublication = {
  subscribeFacts(listener: (change: FactChange) => void) {
    return registerListener(state.facts, listener);
  },
  stage(database: DatabaseSync, rows: readonly RegistryRow[], removed = false) {
    if (state.installingFacts) {
      throw new Error("Sandbox registry cannot mutate during fact installation");
    }
    const changes: Change[] = rows.map((row) => ({
      key: JSON.stringify([row.registry_kind, row.container_name]),
      fact: removed ? { kind: "absent" } : { kind: "postimage", value: { ...row } },
    }));
    if (!changes.length) {
      return;
    }
    const captured = state.capture.getStore();
    if (captured) {
      const start = captured.length;
      if (
        !stageSqliteTransactionState(database, {
          stage: () => captured.push(...changes),
          commit() {},
          rollback: () => captured.splice(start),
        })
      ) {
        throw new Error("Sandbox receipt capture requires its transaction owner");
      }
    }
    const committed = publication(receiptFor(database, changes));
    if (!stageSqliteCommittedPublication(database, committed) && !database.isTransaction) {
      publishSqliteCommittedState(committed);
    }
  },
};

/** Capture the same postimages for native installation and transport, including no-op settlement. */
export function withSandboxRegistryWorkerReceipt<T>(database: DatabaseSync, write: () => T): T {
  return state.capture.run([], () => {
    const result = write();
    const receipt = receiptFor(database, state.capture.getStore()!);
    // A large postimage cannot make a committed command replayable after transport rejection.
    deferSqliteWorkerCommitReceipt(
      database,
      serialize(receipt).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
        ? receipt
        : { kind: "unknown", identity: receipt.source.identity },
      receipt.facts.size ? "commit" : "settlement",
    );
    return result;
  });
}

function readReceipt(value: unknown, identity: string): Receipt {
  if (
    !isRecord(value) ||
    !isRecord(value.source) ||
    typeof value.source.incarnation !== "string" ||
    !(value.facts instanceof Map) ||
    !hasSqliteCommitReceiptCoverage(value, {
      source: { identity, incarnation: value.source.incarnation },
      domain: "sandbox-registry",
      keys: [...value.facts.keys()],
    }) ||
    ![...value.facts].every(
      ([key, fact]) =>
        typeof key === "string" &&
        (fact.kind === "absent" ||
          fact.kind === "unknown" ||
          (fact.kind === "postimage" &&
            isRecord(fact.value) &&
            typeof fact.value.registry_kind === "string" &&
            typeof fact.value.container_name === "string" &&
            key === JSON.stringify([fact.value.registry_kind, fact.value.container_name]))),
    )
  ) {
    throw new Error("Sandbox registry commit receipt is invalid");
  }
  // SAFETY: The private worker owns row codecs; envelope, source, and exact row keys are checked.
  return value as Receipt;
}

/** Native settlement owns pending facts even when the ordinary worker reply is lost. */
export function withSandboxRegistryPublication(
  factory: SqliteWorkerAdmissionFactory,
  identity: () => string,
  assertCurrent: () => void,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    let owner: ReturnType<SqliteWorkerAdmissionFactory>;
    try {
      installFacts({ kind: "pending", identity: identity(), operation });
      owner = factory(operation);
    } catch (error) {
      notifyListeners(state.facts, {
        kind: "settled",
        identity: identity(),
        operation,
        outcome: "unknown",
      });
      throw error;
    }
    const superseded = new Set<string>();
    let installing = false;
    let published = false;
    let unknown = false;
    const unsubscribe = sandboxRegistryPublication.subscribeFacts((change) => {
      if (installing) {
        return;
      }
      if ("kind" in change) {
        if (
          change.identity === identity() &&
          (change.kind === "unknown" || (change.kind === "settled" && change.outcome === "unknown"))
        ) {
          unknown = true;
        }
      } else if (change.source.identity === identity()) {
        for (const key of change.facts.keys()) {
          superseded.add(key);
        }
      }
    });
    let finished = false;
    const finish = owner.admission.finish.bind(owner.admission);
    owner.admission.finish = () => {
      try {
        finish();
      } finally {
        if (!finished) {
          finished = true;
          unsubscribe();
          notifyListeners(state.facts, {
            kind: "settled",
            identity: identity(),
            operation,
            outcome:
              published && !unknown && owner.admission.settlement?.kind === "completed"
                ? "published"
                : "unknown",
          });
        }
      }
    };
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => {
      assertCurrent();
      if (isRecord(facts) && facts.kind === "unknown" && facts.identity === identity()) {
        unknown = true;
        installing = true;
        try {
          installFacts({ kind: "unknown", identity: identity() });
          published = true;
        } finally {
          installing = false;
        }
        return;
      }
      const receipt = readReceipt(facts, identity());
      const installed: Receipt = {
        ...receipt,
        facts: new Map(
          [...receipt.facts].map(([key, fact]) => [
            key,
            unknown || superseded.has(key) ? { kind: "unknown" } : fact,
          ]),
        ),
      };
      installing = true;
      try {
        publishSqliteCommittedState(publication(installed));
        published = true;
      } finally {
        installing = false;
      }
    });
    return owner;
  };
}

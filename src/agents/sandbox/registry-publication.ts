import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Selectable } from "kysely";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { SqliteCommitReceipt } from "../../infra/sqlite-commit-receipt.js";
import { SQLITE_WORKER_MAX_MESSAGE_BYTES } from "../../infra/sqlite-worker-contract.js";
import {
  deferSqliteWorkerCommitReceipt,
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionFactory,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  createKeyedStateDomainPublication,
  type StateDomainChange,
} from "../../state/state-domain-publication.js";

type RegistryRow = Selectable<DB["sandbox_registry_entries"]>;
type Receipt = SqliteCommitReceipt<RegistryRow>;
type FactChange = Receipt | Exclude<StateDomainChange<RegistryRow>, { kind: "committed" }>;

const publication = createKeyedStateDomainPublication<RegistryRow>({
  domain: "sandbox-registry",
  isFact: (key, fact) =>
    fact.kind === "absent" ||
    fact.kind === "unknown" ||
    (fact.kind === "postimage" &&
      isRecord(fact.value) &&
      typeof fact.value.registry_kind === "string" &&
      typeof fact.value.container_name === "string" &&
      key === JSON.stringify([fact.value.registry_kind, fact.value.container_name])),
  invalidReceiptMessage: "Sandbox registry commit receipt is invalid",
  installFailureMessage: "Sandbox registry fact installation failed",
  mutationDuringInstallMessage: "Sandbox registry cannot mutate during fact installation",
  changedOwnerMessage: "Sandbox registry commit receipt is invalid",
});

/** Typed kernels publish rows; raw SQL/trigger writers remain incomplete and retain live guards. */
export const sandboxRegistryPublication = {
  subscribeFacts(listener: (change: FactChange) => void) {
    return publication.subscribeFacts((change) =>
      listener(change.kind === "committed" ? change.receipt : change),
    );
  },
  stage(database: EngineConnection, rows: readonly RegistryRow[], removed = false) {
    publication.stageFacts(
      database,
      new Map(
        rows.map((row) => [
          JSON.stringify([row.registry_kind, row.container_name]),
          removed ? { kind: "absent" } : { kind: "postimage", value: { ...row } },
        ]),
      ),
    );
  },
};

/** Capture the same postimages for native installation and transport, including no-op settlement. */
export function withSandboxRegistryWorkerReceipt<T>(database: EngineConnection, write: () => T): T {
  const { result, receipt } = publication.capture(database, write);
  // A large postimage cannot make a committed command replayable after transport rejection.
  deferSqliteWorkerCommitReceipt(
    database,
    serialize(receipt).byteLength <= SQLITE_WORKER_MAX_MESSAGE_BYTES
      ? receipt
      : { kind: "unknown", identity: receipt.source.identity },
    receipt.facts.size ? "commit" : "settlement",
  );
  return result;
}

/** Native settlement owns pending facts even when the ordinary worker reply is lost. */
export function withSandboxRegistryPublication(
  factory: SqliteWorkerAdmissionFactory,
  identity: () => string,
  assertCurrent: () => void,
): SqliteWorkerAdmissionFactory {
  return (operation) => {
    const pending = publication.begin({ identity: identity(), assertCurrent });
    let owner: ReturnType<SqliteWorkerAdmissionFactory>;
    try {
      owner = factory(operation);
    } catch (error) {
      pending.finish(false);
      throw error;
    }
    const finish = owner.admission.finish.bind(owner.admission);
    owner.admission.finish = () => {
      try {
        finish();
      } finally {
        pending.finish(owner.admission.settlement?.kind === "completed");
      }
    };
    observeSqliteWorkerCommittedFacts(owner.admission, ({ facts }) => pending.committed(facts));
    return owner;
  };
}

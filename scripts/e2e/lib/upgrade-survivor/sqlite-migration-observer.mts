import { AsyncLocalStorage } from "node:async_hooks";
import type * as NativeChildProcess from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type * as NativeSqlite from "node:sqlite";
import type * as NativeWorkerThreads from "node:worker_threads";
import type {
  ObservedSqliteStatement,
  SqliteAuthorization,
  SqliteCatalog,
  SqliteMigrationObservation,
  SqliteTableFact,
} from "./sqlite-migration-observation.mts";

const require = createRequire(import.meta.url);
const sqlite: typeof NativeSqlite = require("node:sqlite");
// Do not create SQLite's ESM facade before replacing its native export.
const { DatabaseSync, StatementSync, constants } = sqlite;
type DatabaseSync = NativeSqlite.DatabaseSync;
type StatementSync = NativeSqlite.StatementSync;
const childProcess: typeof NativeChildProcess = require("node:child_process");
const workerThreads: typeof NativeWorkerThreads = require("node:worker_threads");
type Authorizer = Parameters<DatabaseSync["setAuthorizer"]>[0];
type Frame = { authorizations: SqliteAuthorization[]; instrumentation?: boolean };
type Connection = {
  db: DatabaseSync;
  id: number;
  path: string | null;
  logical: Authorizer;
  installed: boolean;
  frames: Frame[];
  cookie?: string;
  catalog?: SqliteCatalog;
};
type Prepared = { connection: Connection; sql: string; authorizations: SqliteAuthorization[] };
const emptyCatalog = (): SqliteCatalog => ({ tables: [], indexes: [] });
let installed = false;

export type SqliteMigrationObserver = {
  qualifyNativeBindings(): Promise<void>;
  observe<T>(
    run: () => T | Promise<T>,
  ): Promise<{ value: T; observation: SqliteMigrationObservation }>;
  withOwnerIntegrity<T>(name: string, run: () => T): T;
  withMigrationWork<T>(run: () => T): T;
  readFailureObservation(error: unknown): SqliteMigrationObservation | undefined;
  dispose(): void;
};

/** Install before opening production handles or registering logical authorizers.
 * Native SQLite has no getter for a previously installed authorizer.
 * Qualify native named exports before loading a real source chain.
 * Migration subprocess/worker creation is rejected except within owner integrity.
 */
export function installSqliteMigrationObserver(): SqliteMigrationObserver {
  if (installed) {
    throw new Error("SQLite migration observer is already installed");
  }
  installed = true;
  const scopes = new AsyncLocalStorage<SqliteMigrationObservation>();
  const integrity = new AsyncLocalStorage<string>();
  const connections = new Map<DatabaseSync, Connection>();
  const prepared = new WeakMap<StatementSync, Prepared>();
  const iterators = new WeakMap<object, Prepared>();
  const restores: Array<() => void> = [];
  const faults = new Set<string>();
  const failures = new WeakMap<object, SqliteMigrationObservation>();
  let disposed = false;
  let retained = 0;
  // A bounded receipt must fail setup, never silently become partial evidence.
  const limit = 200_000;
  const nativePrepare = Reflect.get(DatabaseSync.prototype, "prepare") as DatabaseSync["prepare"];
  // Catalog queries use the checked zero-binding overload, not the named-bind overload.
  const nativeAll: (this: StatementSync) => ReturnType<StatementSync["all"]> = Reflect.get(
    StatementSync.prototype,
    "all",
  ) as StatementSync["all"];
  const nativeSetAuthorizer = Reflect.get(
    DatabaseSync.prototype,
    "setAuthorizer",
  ) as DatabaseSync["setAuthorizer"];
  const nativeLocation = Reflect.get(
    DatabaseSync.prototype,
    "location",
  ) as DatabaseSync["location"];
  const fail = (message: string) => {
    const observation = scopes.getStore();
    if (observation && !observation.coverageFailures.includes(message)) {
      observation.coverageFailures.push(message);
    }
  };
  const reserve = (count = 1) => {
    retained += count;
    if (retained > limit) {
      faults.add(`SQLite observation retention limit exceeded (${limit})`);
      return false;
    }
    return true;
  };
  const checkFaults = () => {
    for (const fault of faults) {
      fail(fault);
    }
    if (faults.size) {
      throw new Error([...faults].join("; "));
    }
  };
  const patch = (target: object, key: PropertyKey, value: unknown) => {
    const descriptor = Object.getOwnPropertyDescriptor(target, key);
    if (!descriptor) {
      throw new Error(`Missing SQLite instrumentation surface: ${String(key)}`);
    }
    Object.defineProperty(target, key, { ...descriptor, value });
    restores.push(() => Object.defineProperty(target, key, descriptor));
  };
  const connection = (db: DatabaseSync): Connection => {
    let state = connections.get(db);
    if (!state) {
      if (!reserve()) {
        checkFaults();
      }
      state = {
        db,
        id: connections.size + 1,
        path: null,
        logical: null,
        installed: false,
        frames: [],
      };
      connections.set(db, state);
    }
    return state;
  };
  const arm = (state: Connection) => {
    if (state.installed) {
      return;
    }
    // Never use db.setAuthorizer: production's instance setter controls admission.
    nativeSetAuthorizer.call(state.db, (action, argument1, argument2, schema, triggerOrView) => {
      // Recording cannot throw through SQLite's C callback. Logical callbacks keep
      // their native return/throw semantics, including during our catalog reads.
      try {
        const frame = state.frames.at(-1);
        if (frame && !frame.instrumentation) {
          if (reserve()) {
            frame.authorizations.push({ action, argument1, argument2, schema, triggerOrView });
          }
        } else if (!frame && scopes.getStore()) {
          fail(`Database ${state.id}: authorizer callback without a wrapped operation`);
        }
      } catch {
        faults.add("SQLite authorization recorder failed");
      }
      return state.logical
        ? Reflect.apply(state.logical, undefined, [
            action,
            argument1,
            argument2,
            schema,
            triggerOrView,
          ])
        : constants.SQLITE_OK;
    });
    state.installed = true;
    state.path = nativeLocation.call(state.db);
  };
  const withFrame = <T,>(state: Connection, frame: Frame, run: () => T): T => {
    state.frames.push(frame);
    try {
      return run();
    } finally {
      state.frames.pop();
    }
  };
  const text = (value: unknown): string => {
    if (typeof value !== "string") {
      throw new Error("Unexpected SQLite catalog text");
    }
    return value;
  };
  const integer = (value: unknown): number => {
    const number = typeof value === "bigint" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isSafeInteger(number)) {
      throw new Error("Unexpected SQLite catalog integer");
    }
    return number;
  };
  const nullableText = (value: unknown) => (value === null ? null : text(value));
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const catalog = (state: Connection): SqliteCatalog => {
    if (!scopes.getStore()) {
      return emptyCatalog();
    }
    try {
      return withFrame(state, { authorizations: [], instrumentation: true }, () => {
        const rows = (sql: string) => nativeAll.call(nativePrepare.call(state.db, sql));
        const databases = rows("PRAGMA database_list");
        const schemas = databases.map((row) => text(row.name));
        // TEMP exists even before it appears in database_list.
        if (!schemas.includes("temp")) {
          schemas.push("temp");
        }
        const cookie = JSON.stringify([
          databases.map((row) => [text(row.name), text(row.file)]),
          schemas.map((schema) => [
            schema,
            rows(`PRAGMA ${quote(schema)}.schema_version`).map((row) =>
              integer(row.schema_version),
            ),
          ]),
        ]);
        if (state.cookie === cookie && state.catalog) {
          return state.catalog;
        }
        const result = emptyCatalog();
        for (const schema of schemas) {
          const kinds = new Map(
            rows(`PRAGMA ${quote(schema)}.table_list`).map((row) => [
              text(row.name),
              text(row.type),
            ]),
          );
          for (const row of rows(
            `SELECT type, name, tbl_name, rootpage, sql FROM ${quote(schema)}.sqlite_schema`,
          )) {
            if (!reserve()) {
              checkFaults();
            }
            if (row.type === "index") {
              result.indexes.push({
                schema,
                name: text(row.name),
                table: text(row.tbl_name),
                rootpage: integer(row.rootpage),
                sql: nullableText(row.sql),
              });
            } else if (row.type === "table" || row.type === "view") {
              const name = text(row.name);
              const kind = kinds.get(name);
              if (kind !== "table" && kind !== "virtual" && kind !== "shadow" && kind !== "view") {
                throw new Error(`Unknown SQLite table kind: ${kind}`);
              }
              const table: SqliteTableFact = {
                schema,
                name,
                type: kind,
                sql: nullableText(row.sql),
                rootpage: integer(row.rootpage),
                columns: rows(`PRAGMA ${quote(schema)}.table_xinfo(${quote(name)})`).map(
                  (column) => {
                    if (!reserve()) {
                      checkFaults();
                    }
                    return {
                      cid: integer(column.cid),
                      name: text(column.name),
                      type: text(column.type),
                      notNull: integer(column.notnull) !== 0,
                      defaultValue: nullableText(column.dflt_value),
                      primaryKey: integer(column.pk),
                      hidden: integer(column.hidden),
                    };
                  },
                ),
              };
              result.tables.push(table);
            }
          }
        }
        state.cookie = cookie;
        state.catalog = result;
        return result;
      });
    } catch (error) {
      fail(`Database ${state.id}: catalog capture failed: ${String(error)}`);
      return emptyCatalog();
    }
  };
  const execute = <T,>(
    item: Prepared,
    method: ObservedSqliteStatement["method"],
    run: () => T,
  ): T => {
    if (disposed) {
      return run();
    }
    const state = item.connection;
    arm(state);
    const observation = scopes.getStore();
    const frame: Frame = { authorizations: [] };
    const before = observation ? catalog(state) : emptyCatalog();
    let record: ObservedSqliteStatement | undefined;
    if (observation && reserve()) {
      record = {
        databaseId: state.id,
        databasePath: state.path,
        method,
        sql: item.sql,
        ownerIntegrity: integrity.getStore() !== undefined,
        preparedAuthorizations: item.authorizations,
        executedAuthorizations: frame.authorizations,
        before,
        after: before,
      };
      observation.statements.push(record);
    }
    try {
      return withFrame(state, frame, run);
    } finally {
      // Direct schema-cookie/catalog edits must not make stale facts look settled.
      const editsCatalog = (entry: SqliteAuthorization) =>
        (entry.action === constants.SQLITE_PRAGMA &&
          entry.argument2 !== null &&
          ["schema_version", "writable_schema"].includes(entry.argument1?.toLowerCase() ?? "")) ||
        ([constants.SQLITE_INSERT, constants.SQLITE_UPDATE, constants.SQLITE_DELETE].includes(
          entry.action,
        ) &&
          ["sqlite_master", "sqlite_schema", "sqlite_temp_master", "sqlite_temp_schema"].includes(
            entry.argument1 ?? "",
          ));
      if (item.authorizations.some(editsCatalog) || frame.authorizations.some(editsCatalog)) {
        state.cookie = undefined;
      }
      if (record) {
        record.after = catalog(state);
      }
      // A successful live reprepare becomes the next execution's provenance too.
      // Keep the original intentions as well: failed recompiles cannot erase them.
      const additions = frame.authorizations.filter(
        (entry) =>
          !item.authorizations.some(
            (known) =>
              known.action === entry.action &&
              known.argument1 === entry.argument1 &&
              known.argument2 === entry.argument2 &&
              known.schema === entry.schema &&
              known.triggerOrView === entry.triggerOrView,
          ),
      );
      if (additions.length && reserve(additions.length)) {
        item.authorizations = [...item.authorizations, ...additions];
      }
    }
  };
  const unsupported = (name: string): never => {
    const message = `Unsupported SQLite observation API: ${name}`;
    fail(message);
    throw new Error(message);
  };
  const guardedMethods = new WeakMap<object, Set<string>>();
  let statementIteratorPrototype: object;
  const guardMethods = (target: object, names: string[]) => {
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(target, name);
      if (guardedMethods.get(target)?.has(name)) {
        continue;
      }
      if (typeof descriptor?.value !== "function") {
        continue;
      }
      const original: (...args: unknown[]) => unknown = descriptor.value;
      const namesForTarget = guardedMethods.get(target) ?? new Set<string>();
      namesForTarget.add(name);
      guardedMethods.set(target, namesForTarget);
      patch(target, name, function (this: unknown, ...args: unknown[]) {
        if (scopes.getStore()) {
          unsupported(name);
        }
        const result: unknown = Reflect.apply(original, this, args);
        if (name === "iterate" && typeof result === "object" && result !== null) {
          const prototype: object = Object.getPrototypeOf(result);
          if (prototype !== statementIteratorPrototype) {
            guardMethods(prototype, ["next"]);
          }
        }
        return result;
      });
    }
  };
  const dispose = () => {
    if (disposed) {
      return;
    }
    disposed = true;
    let failure: unknown;
    let failed = false;
    for (const state of connections.values()) {
      try {
        if (state.installed && state.db.isOpen) {
          nativeSetAuthorizer.call(state.db, state.logical);
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
    for (const restore of restores.toReversed()) {
      try {
        restore();
      } catch (error) {
        failed = true;
        failure = error;
      }
    }
    syncBuiltinESMExports();
    connections.clear();
    installed = false;
    if (failed) {
      throw failure;
    }
  };
  try {
    const guardProcessBoundary = (name: string) => {
      if (scopes.getStore() && integrity.getStore() === undefined) {
        unsupported(name);
      }
    };
    for (const name of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const) {
      const original = childProcess[name];
      patch(
        childProcess,
        name,
        new Proxy(original, {
          apply(target, receiver, args) {
            guardProcessBoundary(`child_process.${name}`);
            return Reflect.apply(target, receiver, args);
          },
        }),
      );
    }
    const nativeSpawn = Reflect.get(childProcess.ChildProcess.prototype, "spawn") as (
      ...args: unknown[]
    ) => unknown;
    patch(
      childProcess.ChildProcess.prototype,
      "spawn",
      new Proxy(nativeSpawn, {
        apply(target, receiver, args) {
          guardProcessBoundary("ChildProcess.spawn");
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    patch(
      workerThreads,
      "Worker",
      new Proxy(workerThreads.Worker, {
        construct(target, args, newTarget) {
          guardProcessBoundary("worker_threads.Worker");
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    for (const method of ["close", Symbol.dispose] as const) {
      const original = Reflect.get(DatabaseSync.prototype, method) as DatabaseSync[typeof method];
      patch(DatabaseSync.prototype, method, function (this: DatabaseSync) {
        const result = original.call(this);
        const state = connections.get(this);
        if (state && !this.isOpen) {
          state.installed = false;
          state.logical = null;
          state.cookie = undefined;
          state.catalog = undefined;
        }
        return result;
      });
    }
    patch(
      DatabaseSync.prototype,
      "setAuthorizer",
      function (this: DatabaseSync, callback: Authorizer) {
        if (!(this instanceof DatabaseSync)) {
          return nativeSetAuthorizer.call(this, callback);
        }
        const state = connection(this);
        if (!state.installed) {
          // Preserve native validation before storing the logical callback.
          const result = nativeSetAuthorizer.call(this, callback);
          state.logical = callback;
          return result;
        }
        if (callback !== null && typeof callback !== "function") {
          return nativeSetAuthorizer.call(this, callback);
        }
        const previous = state.logical;
        state.logical = callback;
        // The composite remains nonnull on logical null; cache-expiry parity is
        // intentionally not claimed for that transition.
        state.installed = false;
        try {
          arm(state);
        } catch (error) {
          state.logical = previous;
          state.installed = true;
          throw error;
        }
      },
    );
    patch(
      DatabaseSync.prototype,
      "prepare",
      function (this: DatabaseSync, ...args: Parameters<DatabaseSync["prepare"]>) {
        if (!(this instanceof DatabaseSync)) {
          return nativePrepare.apply(this, args);
        }
        checkFaults();
        const state = connection(this);
        arm(state);
        const frame: Frame = { authorizations: [] };
        const statement = withFrame(state, frame, () => nativePrepare.apply(this, args));
        if (reserve()) {
          let sql = args[0];
          try {
            sql = statement.sourceSQL;
          } catch {
            // Empty native statements defer their error until execution.
          }
          prepared.set(statement, { connection: state, sql, authorizations: frame.authorizations });
        }
        checkFaults();
        return statement;
      },
    );
    const nativeExec = Reflect.get(DatabaseSync.prototype, "exec") as DatabaseSync["exec"];
    patch(
      DatabaseSync.prototype,
      "exec",
      function (this: DatabaseSync, ...args: Parameters<DatabaseSync["exec"]>) {
        if (!(this instanceof DatabaseSync)) {
          return nativeExec.apply(this, args);
        }
        checkFaults();
        const state = connection(this);
        return execute({ connection: state, sql: args[0], authorizations: [] }, "exec", () =>
          nativeExec.apply(this, args),
        );
      },
    );
    for (const method of ["all", "get", "run", "iterate"] as const) {
      const original = Reflect.get(StatementSync.prototype, method) as StatementSync[typeof method];
      patch(
        StatementSync.prototype,
        method,
        function (this: StatementSync, ...args: Parameters<StatementSync["all"]>) {
          if (!(this instanceof StatementSync)) {
            return Reflect.apply(original, this, args);
          }
          const item = prepared.get(this);
          if (!item) {
            if (scopes.getStore()) {
              unsupported("preexisting statement without preparation provenance");
            }
            return Reflect.apply(original, this, args);
          }
          if (method === "iterate") {
            // Binding is not execution; the shared iterator next wrapper steps it.
            const rows = Reflect.apply(original, this, args);
            iterators.set(rows, item);
            return rows;
          }
          return execute(item, method, () => Reflect.apply(original, this, args));
        },
      );
    }
    // Discover native prototypes without depending on unexported constructors.
    // These saved native calls occur before any observed chain.
    const scratch = new DatabaseSync(":memory:");
    try {
      const statement = nativePrepare.call(scratch, "SELECT 1");
      const iterate: (this: StatementSync) => ReturnType<StatementSync["iterate"]> = Reflect.get(
        StatementSync.prototype,
        "iterate",
      ) as StatementSync["iterate"];
      const iterator = iterate.call(statement);
      const iteratorPrototype: object = Object.getPrototypeOf(iterator);
      statementIteratorPrototype = iteratorPrototype;
      const next = Reflect.get(iterator, "next") as typeof iterator.next;
      patch(
        iteratorPrototype,
        "next",
        function (this: typeof iterator, ...args: Parameters<typeof next>) {
          const item = iterators.get(this);
          if (!item) {
            if (scopes.getStore()) {
              unsupported("unattributed iterator.next");
            }
            return next.apply(this, args);
          }
          return execute(item, "iterate", () => next.apply(this, args));
        },
      );
      iterator.return?.();
      const session = scratch.createSession();
      try {
        guardMethods(Object.getPrototypeOf(session), ["changeset", "patchset"]);
      } finally {
        session.close();
      }
    } finally {
      scratch.close();
    }
    const createTags = Reflect.get(
      DatabaseSync.prototype,
      "createTagStore",
    ) as DatabaseSync["createTagStore"];
    patch(
      DatabaseSync.prototype,
      "createTagStore",
      function (this: DatabaseSync, ...args: Parameters<typeof createTags>) {
        if (scopes.getStore()) {
          unsupported("createTagStore");
        }
        const tags = createTags.apply(this, args);
        // Native tag stores have per-store prototypes, unlike ordinary statements.
        guardMethods(Object.getPrototypeOf(tags), ["all", "get", "run", "iterate"]);
        return tags;
      },
    );
    guardMethods(DatabaseSync.prototype, [
      "createSession",
      "applyChangeset",
      "serialize",
      "deserialize",
      "loadExtension",
    ]);
    const backup = sqlite.backup;
    patch(sqlite, "backup", function (this: unknown, ...args: Parameters<typeof backup>) {
      if (scopes.getStore()) {
        unsupported("backup");
      }
      return Reflect.apply(backup, this, args);
    });
    syncBuiltinESMExports();
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    async qualifyNativeBindings() {
      // Loading-boundary test: this must create the real facade, never a rewritten binding.
      const named = await import("node:sqlite");
      if (
        named.backup !== sqlite.backup ||
        named.DatabaseSync !== DatabaseSync ||
        named.StatementSync !== StatementSync
      ) {
        throw new Error(
          "Cannot qualify native SQLite exports: install the observer before the first SQLite ESM import",
        );
      }
    },
    async observe<T>(
      run: () => T | Promise<T>,
    ): Promise<{ value: T; observation: SqliteMigrationObservation }> {
      if (disposed || scopes.getStore()) {
        throw new Error("SQLite observation is disposed or nested");
      }
      const observation: SqliteMigrationObservation = {
        statements: [],
        integrityChecks: [],
        coverageFailures: [],
      };
      return scopes.run(observation, async () => {
        let value: T;
        try {
          checkFaults();
          value = await run();
          checkFaults();
          if (observation.coverageFailures.length) {
            throw new Error(
              `SQLite observation coverage failed: ${observation.coverageFailures.join("; ")}`,
            );
          }
        } catch (error) {
          for (const fault of faults) {
            fail(fault);
          }
          // Rethrow even undefined/null/false. Never turn a falsey rejection into success.
          if ((typeof error === "object" && error !== null) || typeof error === "function") {
            failures.set(error, observation);
          }
          throw error;
        }
        return { value, observation };
      });
    },
    withOwnerIntegrity<T>(name: string, run: () => T): T {
      const observation = scopes.getStore();
      if (observation && reserve()) {
        observation.integrityChecks.push(name);
      }
      return integrity.run(name, run);
    },
    withMigrationWork<T>(run: () => T): T {
      return integrity.exit(run);
    },
    readFailureObservation(error: unknown) {
      return (typeof error === "object" && error !== null) || typeof error === "function"
        ? failures.get(error)
        : undefined;
    },
    dispose,
  };
}

import type { WorkboardPersistence } from "./persistence-types.js";
import type { WorkboardSqliteResult } from "./sqlite-store-errors.js";

type Operation<Method extends (...args: never[]) => unknown> = {
  input: { connection: number; args: Parameters<Method> };
  output: Awaited<ReturnType<Method>>;
};

type StoreMethods<Prefix extends string, Store> = {
  [Key in keyof Store & string as `${Prefix}.${Key}`]: Store[Key];
};

type WorkboardSqliteStoreMethods = StoreMethods<"cards", WorkboardPersistence["cards"]> &
  StoreMethods<"boards", WorkboardPersistence["boards"]> &
  StoreMethods<"sessionsBoard", WorkboardPersistence["sessionsBoard"]> &
  StoreMethods<"subscriptions", WorkboardPersistence["subscriptions"]> &
  StoreMethods<"attachments", WorkboardPersistence["attachments"]>;

type WorkboardSqliteStoreOperations = {
  [Key in keyof WorkboardSqliteStoreMethods]: Operation<WorkboardSqliteStoreMethods[Key]>;
};

export type WorkboardSqliteOperations = {
  "connection.open": { input: undefined; output: { connection: number } };
  "connection.close": { input: { connection: number }; output: void };
} & WorkboardSqliteStoreOperations;
export type WorkboardSqliteWorkerOperations = {
  [K in keyof WorkboardSqliteOperations]: {
    input: WorkboardSqliteOperations[K]["input"];
    output: WorkboardSqliteResult<WorkboardSqliteOperations[K]["output"]>;
  };
};

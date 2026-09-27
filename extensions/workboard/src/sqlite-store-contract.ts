import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardSubscriptionStore,
} from "./persistence-types.js";
import type { WorkboardSqliteResult } from "./sqlite-store-errors.js";

export type WorkboardSqliteStoreMethods = {
  "cards.register": WorkboardCardStore["register"];
  "cards.registerIfAbsent": WorkboardCardStore["registerIfAbsent"];
  "cards.registerIfUpdatedAt": WorkboardCardStore["registerIfUpdatedAt"];
  "cards.claimIfOwnerAvailable": WorkboardCardStore["claimIfOwnerAvailable"];
  "cards.deleteIfUpdatedAt": WorkboardCardStore["deleteIfUpdatedAt"];
  "cards.lookup": WorkboardCardStore["lookup"];
  "cards.delete": WorkboardCardStore["delete"];
  "cards.entries": WorkboardCardStore["entries"];
  "cards.listCardStatuses": WorkboardCardStore["listCardStatuses"];
  "cards.listBoardAggregates": WorkboardCardStore["listBoardAggregates"];
  "cards.listStatsAggregates": WorkboardCardStore["listStatsAggregates"];
  "cards.hasCards": WorkboardCardStore["hasCards"];
  "boards.register": WorkboardKeyedStore<PersistedWorkboardBoard>["register"];
  "boards.lookup": WorkboardKeyedStore<PersistedWorkboardBoard>["lookup"];
  "boards.delete": WorkboardKeyedStore<PersistedWorkboardBoard>["delete"];
  "boards.entries": WorkboardKeyedStore<PersistedWorkboardBoard>["entries"];
  "subscriptions.register": WorkboardSubscriptionStore["register"];
  "subscriptions.lookup": WorkboardSubscriptionStore["lookup"];
  "subscriptions.delete": WorkboardSubscriptionStore["delete"];
  "subscriptions.entries": WorkboardSubscriptionStore["entries"];
  "attachments.register": WorkboardKeyedStore<PersistedWorkboardAttachment>["register"];
  "attachments.lookup": WorkboardKeyedStore<PersistedWorkboardAttachment>["lookup"];
  "attachments.delete": WorkboardKeyedStore<PersistedWorkboardAttachment>["delete"];
  "attachments.entries": WorkboardKeyedStore<PersistedWorkboardAttachment>["entries"];
};

type StoreOperations = {
  [K in keyof WorkboardSqliteStoreMethods]: {
    input: { connection: number; args: Parameters<WorkboardSqliteStoreMethods[K]> };
    output: Awaited<ReturnType<WorkboardSqliteStoreMethods[K]>>;
  };
};
export type WorkboardSqliteOperations = StoreOperations & {
  "connection.open": { input: undefined; output: { connection: number; dataVersion: number } };
  "connection.close": { input: { connection: number }; output: void };
  dataVersion: { input: { connection: number }; output: number };
};
export type WorkboardSqliteWorkerOperations = {
  [K in keyof WorkboardSqliteOperations]: {
    input: WorkboardSqliteOperations[K]["input"];
    output: WorkboardSqliteResult<WorkboardSqliteOperations[K]["output"]>;
  };
};

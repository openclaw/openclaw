import type {
  PersistedWorkboardAttachment,
  PersistedWorkboardBoard,
  WorkboardCardStore,
  WorkboardKeyedStore,
  WorkboardSubscriptionStore,
} from "./persistence-types.js";
import type { WorkboardSqliteResult } from "./sqlite-store-errors.js";

type Operation<Method extends (...args: never[]) => unknown> = {
  input: { connection: number; args: Parameters<Method> };
  output: Awaited<ReturnType<Method>>;
};
export type WorkboardSqliteOperations = {
  "connection.open": { input: undefined; output: { connection: number; dataVersion: number } };
  "connection.close": { input: { connection: number }; output: void };
  dataVersion: { input: { connection: number }; output: number };
  "cards.register": Operation<WorkboardCardStore["register"]>;
  "cards.registerIfAbsent": Operation<WorkboardCardStore["registerIfAbsent"]>;
  "cards.registerIfUpdatedAt": Operation<WorkboardCardStore["registerIfUpdatedAt"]>;
  "cards.claimIfOwnerAvailable": Operation<WorkboardCardStore["claimIfOwnerAvailable"]>;
  "cards.deleteIfUpdatedAt": Operation<WorkboardCardStore["deleteIfUpdatedAt"]>;
  "cards.lookup": Operation<WorkboardCardStore["lookup"]>;
  "cards.delete": Operation<WorkboardCardStore["delete"]>;
  "cards.entries": Operation<WorkboardCardStore["entries"]>;
  "cards.listCardStatuses": Operation<WorkboardCardStore["listCardStatuses"]>;
  "cards.listBoardAggregates": Operation<WorkboardCardStore["listBoardAggregates"]>;
  "cards.listStatsAggregates": Operation<WorkboardCardStore["listStatsAggregates"]>;
  "cards.hasCards": Operation<WorkboardCardStore["hasCards"]>;
  "boards.register": Operation<WorkboardKeyedStore<PersistedWorkboardBoard>["register"]>;
  "boards.lookup": Operation<WorkboardKeyedStore<PersistedWorkboardBoard>["lookup"]>;
  "boards.delete": Operation<WorkboardKeyedStore<PersistedWorkboardBoard>["delete"]>;
  "boards.entries": Operation<WorkboardKeyedStore<PersistedWorkboardBoard>["entries"]>;
  "subscriptions.register": Operation<WorkboardSubscriptionStore["register"]>;
  "subscriptions.lookup": Operation<WorkboardSubscriptionStore["lookup"]>;
  "subscriptions.delete": Operation<WorkboardSubscriptionStore["delete"]>;
  "subscriptions.entries": Operation<WorkboardSubscriptionStore["entries"]>;
  "attachments.register": Operation<WorkboardKeyedStore<PersistedWorkboardAttachment>["register"]>;
  "attachments.lookup": Operation<WorkboardKeyedStore<PersistedWorkboardAttachment>["lookup"]>;
  "attachments.delete": Operation<WorkboardKeyedStore<PersistedWorkboardAttachment>["delete"]>;
  "attachments.entries": Operation<WorkboardKeyedStore<PersistedWorkboardAttachment>["entries"]>;
};
export type WorkboardSqliteWorkerOperations = {
  [K in keyof WorkboardSqliteOperations]: {
    input: WorkboardSqliteOperations[K]["input"];
    output: WorkboardSqliteResult<WorkboardSqliteOperations[K]["output"]>;
  };
};

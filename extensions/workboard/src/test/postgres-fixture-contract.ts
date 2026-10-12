import type { SQLInputValue } from "node:sqlite";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import type { DatabaseEngineInput } from "openclaw/plugin-sdk/database-engine-runtime";
import type { WorkboardSqliteResult } from "../sqlite-store-errors.js";

export type PostgresFixtureInput = { dbPath: string; postgresInput: DatabaseEngineInput };
export type PostgresStatement = {
  sql: string;
  args?: SQLInputValue[];
  method?: "run" | "get" | "all";
  catchError?: boolean;
};
export type PostgresFixtureRequest = {
  id: number;
  operation:
    | {
        kind: "statements";
        statements: PostgresStatement[];
        transaction?: boolean;
        reject?: string;
      }
    | { kind: "groupedRollback"; sibling: WorkboardCard; target: WorkboardCard; fault: string }
    | { kind: "state" }
    | { kind: "assertClosed"; sql: string }
    | { kind: "close" };
};
export type PostgresFixtureReply = {
  id: number;
  result: WorkboardSqliteResult<unknown>;
  outcomeUnknown?: boolean;
};

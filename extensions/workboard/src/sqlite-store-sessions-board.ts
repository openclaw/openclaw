import type { DatabaseSync } from "node:sqlite";
import {
  normalizeWorkboardSessionsBoardSpec,
  patchWorkboardSessionsBoardSpec,
  type WorkboardSessionPlacement,
  type WorkboardSessionsBoard,
  type WorkboardSessionsBoardSpec,
} from "@openclaw/workboard-contract";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  iterateSqliteQuerySync,
  runSqliteImmediateTransactionSync,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type {
  PersistedWorkboardBoard,
  WorkboardSessionPlacementWrite,
} from "./persistence-types.js";

type SessionsBoardDatabase = {
  workboard_boards: { id: string; sessions_spec: string | null; updated_at: number };
  workboard_session_placements: {
    board_id: string;
    session_key: string;
    column_id: string;
    source: WorkboardSessionPlacement["source"];
    reason: string;
    facts_hash: string;
    updated_at: number;
  };
};

export class WorkboardSqliteSessionsBoardStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly boards: { lookup(key: string): PersistedWorkboardBoard | undefined },
  ) {}

  get(boardId: string): WorkboardSessionsBoard {
    const board = this.boards.lookup(boardId)?.board;
    if (!board) {
      throw new Error(`board not found: ${boardId}`);
    }
    if (board.kind !== "sessions" || !board.sessions) {
      throw new Error("This board is not a Sessions board.");
    }
    return { ...board, kind: "sessions", sessions: board.sessions };
  }

  update(boardId: string, patch: unknown): WorkboardSessionsBoard {
    return runSqliteImmediateTransactionSync(this.db, () => {
      const current = this.get(boardId);
      const sessions = patchWorkboardSessionsBoardSpec(current.sessions, patch);
      const updatedAt = Math.max(Date.now(), current.updatedAt + 1);
      executeSqliteQuerySync(
        this.db,
        getNodeSqliteKysely<SessionsBoardDatabase>(this.db)
          .updateTable("workboard_boards")
          .set({ sessions_spec: JSON.stringify(sessions), updated_at: updatedAt })
          .where("id", "=", boardId),
      );
      return { ...current, sessions, updatedAt };
    });
  }

  listPlacements(boardId: string): WorkboardSessionPlacement[] {
    const query = getNodeSqliteKysely<SessionsBoardDatabase>(this.db)
      .selectFrom("workboard_session_placements")
      .selectAll()
      .where("board_id", "=", boardId)
      .orderBy("session_key", "asc");
    return Array.from(iterateSqliteQuerySync(this.db, query), (row) => ({
      sessionKey: row.session_key,
      columnId: row.column_id,
      source: row.source,
      reason: row.reason,
      factsHash: row.facts_hash,
      updatedAt: row.updated_at,
    }));
  }

  repairPlacements(): number {
    return Number(
      executeSqliteQuerySync(
        this.db,
        getNodeSqliteKysely<SessionsBoardDatabase>(this.db)
          .deleteFrom("workboard_session_placements")
          .where("source", "!=", "operator"),
      ).numAffectedRows ?? 0n,
    );
  }

  writePlacement(
    boardId: string,
    placement: WorkboardSessionPlacementWrite,
    expectedSpec: WorkboardSessionsBoardSpec,
  ): boolean {
    const expected = JSON.stringify(normalizeWorkboardSessionsBoardSpec(expectedSpec));
    return runSqliteImmediateTransactionSync(this.db, () => {
      const board = this.get(boardId);
      if (JSON.stringify(board.sessions) !== expected) {
        return false;
      }
      if (!board.sessions.columns.some((column) => column.id === placement.columnId)) {
        throw new Error(`Unknown sessions board column: ${placement.columnId}`);
      }
      if (
        !placement.sessionKey ||
        placement.source !== "operator" ||
        typeof placement.reason !== "string" ||
        !Number.isSafeInteger(placement.updatedAt) ||
        placement.updatedAt < 0
      ) {
        throw new Error("Invalid session pin.");
      }
      const query = getNodeSqliteKysely<SessionsBoardDatabase>(this.db);
      const current = executeSqliteQueryTakeFirstSync(
        this.db,
        query
          .selectFrom("workboard_session_placements")
          .select("updated_at")
          .where("board_id", "=", boardId)
          .where("session_key", "=", placement.sessionKey),
      );
      if (current?.updated_at !== placement.expectedUpdatedAt) {
        return false;
      }
      executeSqliteQuerySync(
        this.db,
        query
          .insertInto("workboard_session_placements")
          .values({
            board_id: boardId,
            session_key: placement.sessionKey,
            column_id: placement.columnId,
            source: "operator",
            reason: placement.reason,
            facts_hash: "",
            updated_at: Math.max(placement.updatedAt, (current?.updated_at ?? -1) + 1),
          })
          .onConflict((conflict) =>
            conflict.columns(["board_id", "session_key"]).doUpdateSet((eb) => ({
              column_id: eb.ref("excluded.column_id"),
              source: eb.ref("excluded.source"),
              reason: eb.ref("excluded.reason"),
              facts_hash: eb.ref("excluded.facts_hash"),
              updated_at: eb.ref("excluded.updated_at"),
            })),
          ),
      );
      return true;
    });
  }
}

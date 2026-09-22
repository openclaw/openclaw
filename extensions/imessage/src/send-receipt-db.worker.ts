import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  openNodeSqliteDatabase,
  type SqliteWorkerBackend,
} from "openclaw/plugin-sdk/sqlite-worker-runtime";
import type { IMessageReceiptDbOperations } from "./send-receipt-db.js";
import { normalizeIMessageHandle } from "./targets.js";

type MessagesDatabase = {
  message: {
    ROWID: number | string;
    guid: unknown;
    text: string | null;
    date: number;
    is_from_me: number;
    handle_id: number;
  };
  chat_message_join: { chat_id: number; message_id: number };
  chat: { ROWID: number; guid: string; chat_identifier: string };
  handle: { ROWID: number; id: string; uncanonicalized_id: string };
};

function appleMessageDateLowerBoundMs(sentAfterMs: number | undefined): number | null {
  if (typeof sentAfterMs !== "number" || !Number.isFinite(sentAfterMs)) {
    return null;
  }
  // Messages dates use nanoseconds since 2001; retain five seconds of bridge write skew.
  return Math.max(0, Math.floor((sentAfterMs - 978_307_200_000 - 5_000) * 1_000_000));
}

export function openExistingSqliteWorkerBackend(
  _input: undefined,
  context: { databasePath: string },
): SqliteWorkerBackend<IMessageReceiptDbOperations> {
  const db = openNodeSqliteDatabase(context.databasePath, { readOnly: true });
  return {
    execute(command) {
      const query = getNodeSqliteKysely<MessagesDatabase>(db);
      if (command.type === "messageGuid") {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          query.selectFrom("message").select("guid").where("ROWID", "=", command.input.messageId),
        );
        return typeof row?.guid === "string" ? row.guid : null;
      }
      const { target, text, sentAfterMs } = command.input;
      let selection = query
        .selectFrom("message as m")
        .leftJoin("chat_message_join as cmj", "cmj.message_id", "m.ROWID")
        .leftJoin("chat as c", "c.ROWID", "cmj.chat_id")
        .leftJoin("handle as h", "h.ROWID", "m.handle_id")
        .select("m.guid")
        .where("m.is_from_me", "=", 1);
      if (text) {
        selection = selection.where("m.text", "=", text);
      }
      const lowerBound = appleMessageDateLowerBoundMs(sentAfterMs);
      if (lowerBound !== null) {
        selection = selection.where("m.date", ">=", lowerBound);
      }
      if (target.kind === "chat_id") {
        selection = selection.where("cmj.chat_id", "=", target.chatId);
      } else if (target.kind === "chat_guid") {
        selection = selection.where("c.guid", "=", target.chatGuid);
      } else if (target.kind === "chat_identifier") {
        selection = selection.where("c.chat_identifier", "=", target.chatIdentifier);
      } else {
        selection = selection.where((eb) =>
          eb.or([
            eb("h.id", "=", normalizeIMessageHandle(target.to)),
            eb("h.uncanonicalized_id", "=", target.to),
          ]),
        );
      }
      const rows = executeSqliteQuerySync(
        db,
        selection.orderBy("m.date", "desc").orderBy("m.ROWID", "desc").limit(10),
      ).rows;
      return typeof rows[0]?.guid === "string" ? rows[0].guid : null;
    },
    close() {
      db.close();
    },
  };
}

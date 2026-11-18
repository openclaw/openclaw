import type { Update } from "grammy/types";
import {
  executeSqliteQuerySync,
  getNodeSqliteKysely,
  openOpenClawStateDatabase,
  type OpenClawStateKyselyDatabaseForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";

type TelegramPollingTestDatabase = Pick<
  OpenClawStateKyselyDatabaseForTests,
  "channel_ingress_events"
>;
export type TestTelegramUpdate = Update & {
  message: NonNullable<Update["message"]> & { text: string };
};

const testTelegramSender = {
  id: 111,
  is_bot: false as const,
  first_name: "Ada",
};

export function topicUpdate(updateId: number, threadId: number, text: string): TestTelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_736_380_800,
      from: testTelegramSender,
      text,
      message_thread_id: threadId,
      is_topic_message: true,
      chat: { id: -100, type: "supergroup", title: "Test group" },
    },
  };
}

export function directUpdate(updateId: number, chatId: number, text: string): TestTelegramUpdate {
  const message = {
    message_id: updateId,
    date: 1_736_380_800,
    from: testTelegramSender,
    text,
  };
  if (chatId < 0) {
    return {
      update_id: updateId,
      message: {
        ...message,
        chat: { id: chatId, type: "supergroup", title: "Test group" },
      },
    };
  }
  return {
    update_id: updateId,
    message: {
      ...message,
      chat: { id: chatId, type: "private", first_name: "Ada" },
    },
  };
}

export function forumUpdate(updateId: number, text: string) {
  const update = topicUpdate(updateId, 5907, text);
  update.message.chat.is_forum = true;
  return update;
}

export function openTelegramSpoolTestKysely(stateDir: string) {
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
  return {
    database,
    kysely: getNodeSqliteKysely<TelegramPollingTestDatabase>(database.db),
  };
}

export async function failedUpdateIds(stateDir: string): Promise<number[]> {
  const { database, kysely } = openTelegramSpoolTestKysely(stateDir);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("channel_ingress_events")
      .select("event_id")
      .where("queue_name", "=", JSON.stringify(["telegram", "default"]))
      .where("status", "=", "failed")
      .orderBy("event_id", "asc"),
  ).rows;
  return rows.map((row) => Number(row.event_id));
}

import path from "node:path";
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

function normalizeTelegramTestAccountId(spoolDir: string): string {
  const trimmed = path.basename(spoolDir).trim();
  return trimmed ? trimmed.replace(/[^a-z0-9._-]+/gi, "_") : "default";
}

function telegramTestQueueName(spoolDir: string): string {
  return JSON.stringify(["telegram", normalizeTelegramTestAccountId(spoolDir)]);
}

export function openTelegramSpoolTestKysely(spoolDir: string) {
  const database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: spoolDir },
  });
  return {
    database,
    kysely: getNodeSqliteKysely<TelegramPollingTestDatabase>(database.db),
  };
}

export async function failedUpdateIds(spoolDir: string): Promise<number[]> {
  const { database, kysely } = openTelegramSpoolTestKysely(spoolDir);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("channel_ingress_events")
      .select("event_id")
      .where("queue_name", "=", telegramTestQueueName(spoolDir))
      .where("status", "=", "failed")
      .orderBy("event_id", "asc"),
  ).rows;
  return rows.map((row) => Number(row.event_id));
}

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export type TelegramPrivateAppParticipant = {
  alias: string;
  host: string;
  userId: string;
};

export type TelegramPrivateProductionDescriptor = {
  file: string;
  forumGroupId: string;
  forumTopicId: number;
  mode: "private-production-local-apps";
  participants: TelegramPrivateAppParticipant[];
  topicTitle: string;
};

type TelegramBotIdentity = {
  id: string;
  token: string;
  username: string;
};

function requireString(value: Record<string, unknown>, key: string) {
  const item = value[key];
  if (typeof item !== "string" || !item.trim()) {
    throw new Error(`Telegram private production descriptor has invalid ${key}.`);
  }
  return item.trim();
}

function parseParticipant(value: unknown): TelegramPrivateAppParticipant {
  if (!isRecord(value)) {
    throw new Error("Telegram private production participant is not an object.");
  }
  const participant = {
    alias: requireString(value, "alias"),
    host: requireString(value, "host"),
    userId: requireString(value, "userId"),
  };
  if (!/^\d+$/u.test(participant.userId)) {
    throw new Error("Telegram private production participant has invalid userId.");
  }
  return participant;
}

export function readTelegramPrivateProductionDescriptor(
  file: string | undefined,
): TelegramPrivateProductionDescriptor | undefined {
  if (!file?.trim()) {
    return undefined;
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Telegram private production descriptor must be a regular file.");
  }
  const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!isRecord(value) || value.mode !== "private-production-local-apps") {
    throw new Error("Telegram credential descriptor must select private-production-local-apps.");
  }
  const participants = Array.isArray(value.participants)
    ? value.participants.map(parseParticipant)
    : [];
  if (
    participants.length < 2 ||
    participants[0]?.alias !== "primary" ||
    new Set(participants.map((participant) => participant.alias)).size !== participants.length ||
    new Set(participants.map((participant) => participant.userId)).size !== participants.length
  ) {
    throw new Error(
      "Telegram private production descriptor requires primary plus a distinct local-app participant.",
    );
  }
  const forumGroupId = requireString(value, "forumGroupId");
  if (!/^-\d+$/u.test(forumGroupId)) {
    throw new Error("Telegram private production descriptor has invalid forumGroupId.");
  }
  const forumTopicId = value.forumTopicId;
  if (
    typeof forumTopicId !== "number" ||
    !Number.isSafeInteger(forumTopicId) ||
    forumTopicId <= 0
  ) {
    throw new Error("Telegram private production descriptor has invalid forumTopicId.");
  }
  return {
    file,
    forumGroupId,
    forumTopicId,
    mode: value.mode,
    participants,
    topicTitle: requireString(value, "topicTitle"),
  };
}

async function botApi(bot: TelegramBotIdentity, method: string) {
  try {
    const guarded = await fetchWithSsrFGuard({
      url: `https://api.telegram.org/bot${bot.token}/${method}`,
      init: { method: "POST" },
      timeoutMs: 30_000,
      maxRedirects: 0,
      auditContext: "qa-lab-telegram-private-production-bot-api",
    });
    try {
      const value: unknown = await guarded.response.json();
      if (!guarded.response.ok || !isRecord(value) || value.ok !== true) {
        throw new Error("request rejected");
      }
      return value.result;
    } finally {
      await guarded.release();
    }
  } catch {
    throw new Error(`Telegram private production Bot API ${method} failed.`);
  }
}

export async function resolveTelegramPrivateProductionBot(env: NodeJS.ProcessEnv) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error("Telegram private production proof requires TELEGRAM_BOT_TOKEN.");
  }
  const placeholder = { id: "", token, username: "" };
  const result = await botApi(placeholder, "getMe");
  if (!isRecord(result) || typeof result.id !== "number" || typeof result.username !== "string") {
    throw new Error("Telegram private production bot identity is invalid.");
  }
  return { id: String(result.id), token, username: result.username };
}

function appProofRoot(descriptorFile: string) {
  return `${descriptorFile}.app-proof`;
}

async function readAcknowledgement(params: {
  acknowledgementPath: string;
  destination: "bot-dm" | "forum-topic";
  sentText: string;
  token: string;
}) {
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    try {
      const stat = await fsp.lstat(params.acknowledgementPath);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("Telegram.app proof acknowledgement must be a regular file.");
      }
      const value: unknown = JSON.parse(await fsp.readFile(params.acknowledgementPath, "utf8"));
      if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        value.token !== params.token ||
        value.sentText !== params.sentText ||
        value.replyObservedIn !== params.destination ||
        value.replyToRequestedMessage !== true ||
        typeof value.replyText !== "string" ||
        !value.replyText.trim()
      ) {
        throw new Error("Telegram.app proof acknowledgement is invalid.");
      }
      return value.replyText;
    } catch (error) {
      // SAFETY: Node filesystem rejections carry errno codes; only ENOENT is retryable here.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error("Timed out waiting for Telegram.app send and native reply proof.");
}

export async function requestTelegramPrivateAppTurn(params: {
  descriptor: TelegramPrivateProductionDescriptor;
  destination: "bot-dm" | "forum-topic";
  participant: TelegramPrivateAppParticipant;
  text: string;
}) {
  const root = appProofRoot(params.descriptor.file);
  await fsp.mkdir(root, { recursive: true, mode: 0o700 });
  await fsp.chmod(root, 0o700);
  const token = randomUUID();
  const requestPath = path.join(root, `${token}.request.json`);
  const acknowledgementPath = path.join(root, `${token}.ack.json`);
  await fsp.writeFile(
    requestPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        token,
        participant: { alias: params.participant.alias, host: params.participant.host },
        destination: params.destination,
        ...(params.destination === "forum-topic"
          ? { topicTitle: params.descriptor.topicTitle }
          : {}),
        text: params.text,
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  process.stdout.write(`TELEGRAM_PRIVATE_APP_SEND_REQUIRED ${token}\n`);
  try {
    const replyText = await readAcknowledgement({
      acknowledgementPath,
      destination: params.destination,
      sentText: params.text,
      token,
    });
    return { replyText };
  } finally {
    await Promise.all([
      fsp.rm(requestPath, { force: true }),
      fsp.rm(acknowledgementPath, { force: true }),
    ]);
  }
}

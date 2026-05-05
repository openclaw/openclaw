import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { BlueBubblesCoreRuntime } from "./monitor-shared.js";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import type { BlueBubblesSupervisedRepliesConfig } from "./types.js";

type SmsSupervisorMessage = {
  direction: "inbound" | "outbound";
  text: string;
  timestamp: number;
  message_id?: string;
  short_id?: string;
  attachments?: number;
};

type SmsSupervisorThread = {
  thread_id: string;
  account_id: string;
  reply_target: string;
  sender_id: string;
  sender_name?: string;
  sender_label: string;
  status: "pending" | "held" | "drafted";
  last_inbound_at: number;
  last_inbound_text: string;
  last_inbound_message_id?: string;
  last_inbound_short_id?: string;
  last_notified_at?: number;
  draft?: string;
  history: SmsSupervisorMessage[];
};

type SmsSupervisorLatestItem = {
  rank: number;
  thread_id: string;
  account_id: string;
  reply_target: string;
  sender_id: string;
  sender_name?: string;
  sender_label: string;
  preview: string;
  received_at: number;
  attachments?: number;
  status: SmsSupervisorThread["status"];
};

type SmsSupervisorLatest = {
  generated_at: string;
  items: SmsSupervisorLatestItem[];
};

function resolveSmsSupervisorDir(core: BlueBubblesCoreRuntime): string {
  return path.join(core.state.resolveStateDir(), "workspace", "sms-supervisor");
}

function resolveThreadsDir(core: BlueBubblesCoreRuntime): string {
  return path.join(resolveSmsSupervisorDir(core), "threads");
}

function resolveLatestPath(core: BlueBubblesCoreRuntime): string {
  return path.join(resolveSmsSupervisorDir(core), "latest.json");
}

function resolveConfigPath(core: BlueBubblesCoreRuntime): string {
  return path.join(resolveSmsSupervisorDir(core), "config.json");
}

function resolveThreadPath(core: BlueBubblesCoreRuntime, threadId: string): string {
  return path.join(resolveThreadsDir(core), `${threadId}.json`);
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.rename(tempPath, filePath);
}

function buildThreadId(accountId: string, senderId: string): string {
  return createHash("sha256").update(`${accountId}\0${senderId}`).digest("hex").slice(0, 24);
}

function formatSenderLabel(message: NormalizedWebhookMessage): string {
  const name = message.senderName?.trim();
  if (name) {
    return name;
  }
  return message.senderId;
}

function buildPreview(message: NormalizedWebhookMessage): string {
  const text = message.text.trim();
  if (text) {
    return text.replace(/\s+/g, " ").slice(0, 240);
  }
  const attachmentCount = message.attachments?.length ?? 0;
  if (attachmentCount > 0) {
    return attachmentCount === 1 ? "[1 attachment]" : `[${attachmentCount} attachments]`;
  }
  return "[empty message]";
}

function formatNotification(params: { item: SmsSupervisorLatestItem; message: NormalizedWebhookMessage }): string {
  const { item, message } = params;
  const attachmentLine =
    (message.attachments?.length ?? 0) > 0
      ? `\nAttachments: ${message.attachments?.length}`
      : "";
  return [
    `SMS pending from ${item.sender_label}`,
    "",
    `"${item.preview}"${attachmentLine}`,
    "",
    "No reply was sent.",
    "",
    "Reply here in plain text, for example:",
    `\`show sms ${item.rank}\``,
    `\`draft sms ${item.rank}: Thanks — ...\``,
    `\`send sms ${item.rank}\``,
    `\`hold sms ${item.rank}\``,
  ].join("\n");
}

export async function queueSupervisedBlueBubblesMessage(params: {
  core: BlueBubblesCoreRuntime;
  account: ResolvedBlueBubblesAccount;
  message: NormalizedWebhookMessage;
  messageShortId?: string;
  supervisorConfig: BlueBubblesSupervisedRepliesConfig;
}): Promise<{ threadId: string; rank: number }> {
  const { core, account, message, messageShortId, supervisorConfig } = params;
  const threadId = buildThreadId(account.accountId, message.senderId);
  const nowIso = new Date().toISOString();
  const preview = buildPreview(message);
  const senderLabel = formatSenderLabel(message);
  const threadPath = resolveThreadPath(core, threadId);
  const latestPath = resolveLatestPath(core);
  const existingThread = await readJsonFile<SmsSupervisorThread>(threadPath);

  const inboundEntry: SmsSupervisorMessage = {
    direction: "inbound",
    text: preview,
    timestamp: message.timestamp ?? Date.now(),
    message_id: message.messageId ?? undefined,
    short_id: messageShortId,
    attachments: message.attachments?.length ? message.attachments.length : undefined,
  };

  const nextHistory = [
    ...(existingThread?.history ?? []).filter((entry) => entry.message_id !== inboundEntry.message_id),
    inboundEntry,
  ].slice(-20);

  const nextThread: SmsSupervisorThread = {
    thread_id: threadId,
    account_id: account.accountId,
    reply_target: message.senderId,
    sender_id: message.senderId,
    sender_name: message.senderName?.trim() || undefined,
    sender_label: senderLabel,
    status: "pending",
    last_inbound_at: inboundEntry.timestamp,
    last_inbound_text: preview,
    last_inbound_message_id: inboundEntry.message_id,
    last_inbound_short_id: inboundEntry.short_id,
    last_notified_at: Date.now(),
    draft: existingThread?.draft,
    history: nextHistory,
  };

  await writeJsonFile(threadPath, nextThread);

  const latest = (await readJsonFile<SmsSupervisorLatest>(latestPath)) ?? {
    generated_at: nowIso,
    items: [],
  };
  const nextItems = [
    {
      rank: 0,
      thread_id: threadId,
      account_id: account.accountId,
      reply_target: message.senderId,
      sender_id: message.senderId,
      sender_name: message.senderName?.trim() || undefined,
      sender_label: senderLabel,
      preview,
      received_at: inboundEntry.timestamp,
      attachments: message.attachments?.length ? message.attachments.length : undefined,
      status: "pending" as const,
    },
    ...latest.items.filter((item) => item.thread_id !== threadId),
  ]
    .sort((a, b) => b.received_at - a.received_at)
    .slice(0, 20)
    .map((item, index) => ({ ...item, rank: index + 1 }));

  await writeJsonFile(latestPath, {
    generated_at: nowIso,
    items: nextItems,
  } satisfies SmsSupervisorLatest);

  const currentItem = nextItems.find((item) => item.thread_id === threadId);
  const notifyTo = supervisorConfig.notifyTo?.trim();
  if (notifyTo) {
    const notifyAccountId = supervisorConfig.notifyAccountId?.trim() || "default";
    await core.channel.telegram.sendMessageTelegram(notifyTo, formatNotification({
      item: currentItem ?? nextItems[0],
      message,
    }), {
      accountId: notifyAccountId,
    });
  }

  return { threadId, rank: currentItem?.rank ?? 1 };
}

export async function resolveSupervisedBlueBubblesConfig(params: {
  core: BlueBubblesCoreRuntime;
  account: ResolvedBlueBubblesAccount;
}): Promise<BlueBubblesSupervisedRepliesConfig | null> {
  const { account, core } = params;
  if (account.config.supervisedReplies) {
    return account.config.supervisedReplies.enabled === true ? account.config.supervisedReplies : null;
  }
  const fileConfig = await readJsonFile<BlueBubblesSupervisedRepliesConfig>(resolveConfigPath(core));
  if (!fileConfig || fileConfig.enabled !== true) {
    return null;
  }
  return fileConfig;
}

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  extractOriginalFilename,
  readJsonFileWithFallback,
  withFileLock,
  writeJsonFileAtomically,
} from "openclaw/plugin-sdk/msteams";
import type {
  ArchiveAttachmentRecord,
  ArchiveChannelEntry,
  ArchiveIndex,
  ArchiveInboundMessageInput,
  ArchiveMessageRecord,
  ArchivePruneResult,
  ArchiveSearchParams,
  AttachmentSearchParams,
} from "./types.js";

const INDEX_VERSION = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const STORE_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

type Logger = {
  debug?: (message: string, meta?: Record<string, unknown>) => void;
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

function emptyIndex(): ArchiveIndex {
  return { version: INDEX_VERSION, archives: {} };
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) {
    return DEFAULT_LIMIT;
  }
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    return "attachment.bin";
  }
  const sanitized = trimmed.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/_+/g, "_");
  return sanitized.slice(0, 120) || "attachment.bin";
}

function normalizeConversationId(value: string): string {
  return value.trim();
}

function parseJsonLine<T>(line: string, filePath: string, lineNumber: number): T {
  try {
    return JSON.parse(line) as T;
  } catch (error) {
    throw new Error(`Invalid JSONL in ${filePath} at line ${lineNumber}: ${String(error)}`);
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.promises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseIsoDate(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function includesText(haystack: string | undefined, needle: string | undefined): boolean {
  if (!needle) {
    return true;
  }
  return (haystack ?? "").toLowerCase().includes(needle.toLowerCase());
}

export function createArchiveStore(params: { stateDir: string; logger: Logger }) {
  return new MSTeamsChannelArchiveStore(params);
}

export class MSTeamsChannelArchiveStore {
  private readonly baseDir: string;
  private readonly messagesDir: string;
  private readonly attachmentsDir: string;
  private readonly indexFile: string;
  private readonly logger: Logger;

  constructor(params: { stateDir: string; logger: Logger }) {
    this.baseDir = path.join(params.stateDir, "channel-archive", "msteams");
    this.messagesDir = path.join(this.baseDir, "messages");
    this.attachmentsDir = path.join(this.baseDir, "attachments");
    this.indexFile = path.join(this.baseDir, "index.json");
    this.logger = params.logger;
  }

  getArchiveKey(conversationId: string): string {
    return `msteams:${normalizeConversationId(conversationId)}`;
  }

  async archiveMessage(input: ArchiveInboundMessageInput): Promise<ArchiveMessageRecord> {
    const conversationId = normalizeConversationId(input.conversationId);
    const archiveKey = this.getArchiveKey(conversationId);
    const messageId = input.messageId?.trim() || undefined;
    const replyToId = input.replyToId?.trim() || undefined;
    const derivedThreadId = input.threadId?.trim() || replyToId || messageId;
    const threadRootMessageId = replyToId || messageId;

    await this.ensureBaseDirs();

    return await withFileLock(this.indexFile, STORE_LOCK_OPTIONS, async () => {
      const index = await this.readIndex();
      const messageFile = this.resolveMessageFilePath(index, archiveKey);

      if (messageId) {
        const existing = await this.findMessageInFile(messageFile, messageId);
        if (existing) {
          this.logger.debug?.("msteams-channel-archive: duplicate message skipped", {
            conversationId,
            messageId,
          });
          return existing;
        }
      }

      const attachments = await this.archiveAttachments(input.mediaPaths, input.mediaTypes);
      const record: ArchiveMessageRecord = {
        provider: "msteams",
        archiveKey,
        conversationId,
        conversationType: input.conversationType,
        tenantId: input.tenantId,
        teamId: input.teamId,
        teamName: input.teamName,
        channelId: input.channelId,
        channelName: input.channelName,
        threadId: derivedThreadId,
        threadRootMessageId,
        messageId,
        replyToId,
        timestamp: input.timestamp,
        sender: {
          id: input.senderId,
          name: input.senderName,
        },
        text: input.content,
        rawBody: input.rawBody,
        attachments,
        origin: {
          surface: "msteams",
          chatType: input.chatType,
        },
      };

      await fs.promises.mkdir(path.dirname(messageFile), { recursive: true, mode: 0o700 });
      await fs.promises.appendFile(messageFile, `${JSON.stringify(record)}\n`, "utf8");

      const relativeMessageFile = toPosixPath(path.relative(this.baseDir, messageFile));
      const previous = index.archives[archiveKey];
      index.archives[archiveKey] = {
        archiveKey,
        conversationId,
        messageFile: relativeMessageFile,
        messageCount: (previous?.messageCount ?? 0) + 1,
        createdAt: previous?.createdAt ?? Date.now(),
        updatedAt: Date.now(),
        lastMessageAt: record.timestamp,
      };
      await this.writeIndex(index);
      this.logger.debug?.("msteams-channel-archive: archived message", {
        conversationId,
        messageId,
        attachments: attachments.length,
      });
      return record;
    });
  }

  async getMessage(params: {
    conversationId: string;
    messageId: string;
  }): Promise<ArchiveMessageRecord | null> {
    const archiveKey = this.getArchiveKey(params.conversationId);
    const index = await this.readIndex();
    const messageFile = this.resolveMessageFilePath(index, archiveKey);
    const found = await this.findMessageInFile(messageFile, params.messageId);
    return found ? await this.withAttachmentStatus(found) : null;
  }

  async getThread(params: {
    conversationId: string;
    threadId?: string;
    rootMessageId?: string;
    limit?: number;
  }): Promise<ArchiveMessageRecord[]> {
    const threadKey = params.rootMessageId?.trim() || params.threadId?.trim();
    if (!threadKey) {
      throw new Error("threadId or rootMessageId is required");
    }

    const messages = await this.readArchiveMessages(params.conversationId);
    return (await Promise.all(messages.map((message) => this.withAttachmentStatus(message))))
      .filter(
        (message) =>
          message.threadId === threadKey ||
          message.threadRootMessageId === threadKey ||
          message.messageId === threadKey,
      )
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, clampLimit(params.limit));
  }

  async searchMessages(params: ArchiveSearchParams): Promise<ArchiveMessageRecord[]> {
    const limit = clampLimit(params.limit);
    const conversations = await this.resolveConversations(params.conversationId);
    const results: ArchiveMessageRecord[] = [];

    for (const conversationId of conversations) {
      const messages = await this.readArchiveMessages(conversationId);
      for (const message of messages) {
        if (params.threadId) {
          const threadKey = params.threadId.trim();
          if (
            message.threadId !== threadKey &&
            message.threadRootMessageId !== threadKey &&
            message.messageId !== threadKey
          ) {
            continue;
          }
        }
        if (params.senderId && message.sender.id !== params.senderId) {
          continue;
        }
        if (params.since && message.timestamp < params.since) {
          continue;
        }
        if (params.until && message.timestamp > params.until) {
          continue;
        }
        if (params.hasAttachments != null) {
          const hasAttachments = message.attachments.length > 0;
          if (hasAttachments !== params.hasAttachments) {
            continue;
          }
        }
        if (params.query && !includesText(`${message.text}\n${message.rawBody}`, params.query)) {
          continue;
        }
        results.push(await this.withAttachmentStatus(message));
      }
    }

    return results.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async searchAttachments(params: AttachmentSearchParams): Promise<
    Array<{
      conversationId: string;
      messageId?: string;
      timestamp: number;
      sender: ArchiveMessageRecord["sender"];
      attachment: ArchiveAttachmentRecord;
    }>
  > {
    const limit = clampLimit(params.limit);
    const conversations = await this.resolveConversations(params.conversationId);
    const matches: Array<{
      conversationId: string;
      messageId?: string;
      timestamp: number;
      sender: ArchiveMessageRecord["sender"];
      attachment: ArchiveAttachmentRecord;
    }> = [];

    for (const conversationId of conversations) {
      const messages = await this.readArchiveMessages(conversationId);
      for (const message of messages) {
        if (params.since && message.timestamp < params.since) {
          continue;
        }
        for (const attachment of await this.resolveAttachmentStatuses(message.attachments)) {
          if (params.mime && attachment.mime !== params.mime) {
            continue;
          }
          if (
            params.query &&
            !includesText(
              `${attachment.name}\n${attachment.mime ?? ""}\n${attachment.sha256}`,
              params.query,
            )
          ) {
            continue;
          }
          matches.push({
            conversationId: message.conversationId,
            messageId: message.messageId,
            timestamp: message.timestamp,
            sender: message.sender,
            attachment,
          });
        }
      }
    }

    return matches.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  async listChannelArchives(): Promise<ArchiveChannelEntry[]> {
    const index = await this.readIndex();
    const entries = Object.values(index.archives);
    const results: ArchiveChannelEntry[] = [];

    for (const entry of entries) {
      const messageFile = this.resolveMessageFilePath(index, entry.archiveKey);
      const latestMessage = await this.readLastMessageInFile(messageFile);
      const conversationType = latestMessage?.conversationType ?? latestMessage?.origin.chatType;
      if (conversationType !== "channel") {
        continue;
      }
      results.push({
        ...entry,
        conversationType,
        teamId: latestMessage?.teamId,
        teamName: latestMessage?.teamName,
        channelId: latestMessage?.channelId,
        channelName: latestMessage?.channelName,
      });
    }

    return results.sort(
      (a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt),
    );
  }

  async pruneConversation(conversationId: string): Promise<ArchivePruneResult> {
    const normalizedConversationId = normalizeConversationId(conversationId);
    const archiveKey = this.getArchiveKey(normalizedConversationId);

    return await withFileLock(this.indexFile, STORE_LOCK_OPTIONS, async () => {
      const index = await this.readIndex();
      const existing = index.archives[archiveKey];
      if (!existing) {
        return {
          removed: false,
          conversationId: normalizedConversationId,
          removedMessages: 0,
          removedAttachments: 0,
        };
      }

      const messageFile = this.resolveMessageFilePath(index, archiveKey);
      const removedMessages = await this.readMessagesFromFile(messageFile);
      delete index.archives[archiveKey];
      await this.writeIndex(index);

      if (await fileExists(messageFile)) {
        await fs.promises.rm(messageFile, { force: true });
      }

      const referencedAttachmentPaths = await this.collectReferencedAttachmentPaths(index);
      const removedAttachments = await this.removeUnreferencedAttachments(
        removedMessages,
        referencedAttachmentPaths,
      );

      this.logger.info?.("msteams-channel-archive: pruned archived conversation", {
        conversationId: normalizedConversationId,
        removedMessages: removedMessages.length,
        removedAttachments,
      });

      return {
        removed: true,
        conversationId: normalizedConversationId,
        removedMessages: removedMessages.length,
        removedAttachments,
      };
    });
  }

  private async ensureBaseDirs(): Promise<void> {
    await fs.promises.mkdir(this.messagesDir, { recursive: true, mode: 0o700 });
    await fs.promises.mkdir(this.attachmentsDir, { recursive: true, mode: 0o700 });
  }

  private async readIndex(): Promise<ArchiveIndex> {
    const { value } = await readJsonFileWithFallback<ArchiveIndex>(this.indexFile, emptyIndex());
    if (value.version !== INDEX_VERSION || !value.archives || typeof value.archives !== "object") {
      return emptyIndex();
    }
    return value;
  }

  private async writeIndex(index: ArchiveIndex): Promise<void> {
    await writeJsonFileAtomically(this.indexFile, index);
  }

  private resolveMessageFilePath(index: ArchiveIndex, archiveKey: string): string {
    const entry = index.archives[archiveKey];
    if (entry?.messageFile) {
      return path.join(this.baseDir, entry.messageFile);
    }
    return path.join(this.messagesDir, `${hashText(archiveKey)}.jsonl`);
  }

  private async readArchiveMessages(conversationId: string): Promise<ArchiveMessageRecord[]> {
    const archiveKey = this.getArchiveKey(conversationId);
    const index = await this.readIndex();
    const messageFile = this.resolveMessageFilePath(index, archiveKey);
    return await this.readMessagesFromFile(messageFile);
  }

  private async findMessageInFile(
    messageFile: string,
    messageId: string,
  ): Promise<ArchiveMessageRecord | null> {
    const lines = await this.readMessagesFromFile(messageFile);
    for (const message of lines) {
      if (message.messageId === messageId) {
        return message;
      }
    }
    return null;
  }

  private async readMessagesFromFile(messageFile: string): Promise<ArchiveMessageRecord[]> {
    if (!(await fileExists(messageFile))) {
      return [];
    }
    const raw = await fs.promises.readFile(messageFile, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    return lines.map((line, indexLine) =>
      parseJsonLine<ArchiveMessageRecord>(line, messageFile, indexLine + 1),
    );
  }

  private async readLastMessageInFile(messageFile: string): Promise<ArchiveMessageRecord | null> {
    const messages = await this.readMessagesFromFile(messageFile);
    return messages.at(-1) ?? null;
  }

  private async archiveAttachments(
    mediaPaths: string[],
    mediaTypes: string[],
  ): Promise<ArchiveAttachmentRecord[]> {
    const out: ArchiveAttachmentRecord[] = [];
    for (let index = 0; index < mediaPaths.length; index += 1) {
      const sourcePath = mediaPaths[index]?.trim();
      if (!sourcePath) {
        continue;
      }
      const content = await fs.promises.readFile(sourcePath);
      const sha256 = createHash("sha256").update(content).digest("hex");
      const name = sanitizeFilename(extractOriginalFilename(sourcePath));
      const targetDir = path.join(this.attachmentsDir, sha256.slice(0, 2), sha256);
      const targetPath = path.join(targetDir, name);
      await fs.promises.mkdir(targetDir, { recursive: true, mode: 0o700 });
      if (!(await fileExists(targetPath))) {
        await fs.promises.copyFile(sourcePath, targetPath);
      }
      const stat = await fs.promises.stat(targetPath);
      out.push({
        attachmentId: sha256,
        name,
        mime: mediaTypes[index] || undefined,
        size: stat.size,
        sha256,
        storedPath: toPosixPath(path.relative(this.baseDir, targetPath)),
        sourcePath,
      });
    }
    return out;
  }

  private async resolveConversations(conversationId?: string): Promise<string[]> {
    if (conversationId) {
      return [normalizeConversationId(conversationId)];
    }
    const index = await this.readIndex();
    return Object.values(index.archives)
      .map((entry) => entry.conversationId)
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  }

  private async withAttachmentStatus(message: ArchiveMessageRecord): Promise<ArchiveMessageRecord> {
    return {
      ...message,
      attachments: await this.resolveAttachmentStatuses(message.attachments),
    };
  }

  private async resolveAttachmentStatuses(
    attachments: ArchiveAttachmentRecord[],
  ): Promise<ArchiveAttachmentRecord[]> {
    return await Promise.all(
      attachments.map(async (attachment) => {
        const targetPath = path.join(this.baseDir, attachment.storedPath);
        return {
          ...attachment,
          missing: !(await fileExists(targetPath)),
        };
      }),
    );
  }

  private async collectReferencedAttachmentPaths(index: ArchiveIndex): Promise<Set<string>> {
    const referencedPaths = new Set<string>();
    for (const entry of Object.values(index.archives)) {
      const messageFile = this.resolveMessageFilePath(index, entry.archiveKey);
      const messages = await this.readMessagesFromFile(messageFile);
      for (const message of messages) {
        for (const attachment of message.attachments) {
          referencedPaths.add(attachment.storedPath);
        }
      }
    }
    return referencedPaths;
  }

  private async removeUnreferencedAttachments(
    removedMessages: ArchiveMessageRecord[],
    referencedAttachmentPaths: Set<string>,
  ): Promise<number> {
    const removedAttachmentPaths = new Set(
      removedMessages.flatMap((message) =>
        message.attachments.map((attachment) => attachment.storedPath),
      ),
    );
    let removedCount = 0;
    for (const storedPath of removedAttachmentPaths) {
      if (referencedAttachmentPaths.has(storedPath)) {
        continue;
      }
      const targetPath = path.join(this.baseDir, storedPath);
      if (!(await fileExists(targetPath))) {
        continue;
      }
      await fs.promises.rm(targetPath, { force: true });
      removedCount += 1;
      await this.pruneEmptyParentDirs(path.dirname(targetPath));
    }
    return removedCount;
  }

  private async pruneEmptyParentDirs(startDir: string): Promise<void> {
    let currentDir = startDir;
    while (currentDir.startsWith(this.attachmentsDir) && currentDir !== this.attachmentsDir) {
      try {
        await fs.promises.rmdir(currentDir);
      } catch {
        break;
      }
      currentDir = path.dirname(currentDir);
    }
  }
}

export function parseSearchDate(value: string | undefined): number | undefined {
  return parseIsoDate(value);
}

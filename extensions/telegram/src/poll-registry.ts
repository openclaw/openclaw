import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";

const STORE_VERSION = 1;
const MAX_POLL_REGISTRY_ENTRIES = 100;

export type TelegramPollRegistryEntry = {
  pollId: string;
  chatId: string;
  messageThreadId?: number;
  question: string;
  options: string[];
  createdAt: number;
};

type StoredTelegramPollRegistry = {
  version: number;
  polls: TelegramPollRegistryEntry[];
};

function resolveTelegramPollRegistryPath(
  accountId?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const stateDir = resolveStateDir(env, os.homedir);
  const normalized = normalizeAccountId(accountId);
  return path.join(stateDir, "telegram", `poll-registry-${normalized}.json`);
}

function normalizePollRegistryEntry(raw: unknown): TelegramPollRegistryEntry | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const entry = raw as {
    pollId?: unknown;
    chatId?: unknown;
    messageThreadId?: unknown;
    question?: unknown;
    options?: unknown;
    createdAt?: unknown;
  };
  if (
    typeof entry.pollId !== "string" ||
    typeof entry.chatId !== "string" ||
    typeof entry.question !== "string" ||
    !Array.isArray(entry.options) ||
    !entry.options.every((option) => typeof option === "string") ||
    typeof entry.createdAt !== "number" ||
    !Number.isFinite(entry.createdAt) ||
    (entry.messageThreadId != null &&
      (typeof entry.messageThreadId !== "number" || !Number.isFinite(entry.messageThreadId)))
  ) {
    return null;
  }
  return {
    pollId: entry.pollId,
    chatId: entry.chatId,
    messageThreadId:
      typeof entry.messageThreadId === "number" ? Math.floor(entry.messageThreadId) : undefined,
    question: entry.question,
    options: entry.options,
    createdAt: Math.floor(entry.createdAt),
  };
}

async function readTelegramPollRegistry(params: {
  accountId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StoredTelegramPollRegistry> {
  const filePath = resolveTelegramPollRegistryPath(params.accountId, params.env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as {
      version?: unknown;
      polls?: unknown;
    };
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.polls)) {
      return { version: STORE_VERSION, polls: [] };
    }
    return {
      version: STORE_VERSION,
      polls: parsed.polls
        .map((entry) => normalizePollRegistryEntry(entry))
        .filter((entry): entry is TelegramPollRegistryEntry => entry != null),
    };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return { version: STORE_VERSION, polls: [] };
    }
    logVerbose(
      `telegram: failed to read poll registry at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { version: STORE_VERSION, polls: [] };
  }
}

export async function recordTelegramPollRegistryEntry(params: {
  accountId?: string;
  pollId: string;
  chatId: string;
  messageThreadId?: number;
  question: string;
  options: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const registry = await readTelegramPollRegistry(params);
  const nextEntry: TelegramPollRegistryEntry = {
    pollId: params.pollId,
    chatId: params.chatId,
    messageThreadId:
      typeof params.messageThreadId === "number" ? Math.floor(params.messageThreadId) : undefined,
    question: params.question,
    options: [...params.options],
    createdAt: Date.now(),
  };
  const polls = registry.polls.filter((entry) => entry.pollId !== params.pollId);
  polls.push(nextEntry);
  const pruned = polls.slice(-MAX_POLL_REGISTRY_ENTRIES);
  const filePath = resolveTelegramPollRegistryPath(params.accountId, params.env);
  await writeJsonFileAtomically(filePath, {
    version: STORE_VERSION,
    polls: pruned,
  } satisfies StoredTelegramPollRegistry);
}

export async function findTelegramPollRegistryEntry(params: {
  accountId?: string;
  pollId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<TelegramPollRegistryEntry | null> {
  const registry = await readTelegramPollRegistry(params);
  return registry.polls.find((entry) => entry.pollId === params.pollId) ?? null;
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SlackMissionThreadEntry = {
  platform: "slack";
  missionId: string;
  accountId?: string;
  teamId?: string;
  channelId: string;
  threadTs: string;
  ownerAgent: string;
  createdFromMessageTs: string;
  createdAt: string;
  updatedAt: string;
  routingPolicy: "thread_required";
};

export type SlackMissionThreadStore = {
  missions: Record<string, SlackMissionThreadEntry | undefined>;
};

const DEFAULT_STORE_PATH = path.join(os.homedir(), ".openclaw", "slack-mission-threads.json");
const MISSION_LINE_RE = /^mission:\s*(.+)$/im;
const MISSION_CALLED_RE = /mission called:\s*[“"']?([^\n”"']+)[”"']?/im;
const DEFAULT_SLACK_ACCOUNT_SCOPE = "default";

export function getSlackMissionThreadStorePath(): string {
  const override = process.env.OPENCLAW_SLACK_MISSION_THREAD_STORE?.trim();
  return override || DEFAULT_STORE_PATH;
}

export function detectSlackMissionId(text: string | undefined | null): string | undefined {
  const value = text?.trim();
  if (!value) {
    return undefined;
  }

  const missionLine = value.match(MISSION_LINE_RE)?.[1]?.trim();
  if (missionLine) {
    return missionLine;
  }

  const missionCalled = value.match(MISSION_CALLED_RE)?.[1]?.trim();
  if (missionCalled) {
    return missionCalled;
  }

  return undefined;
}

function normalizeOptionalScope(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function resolveSlackMissionScope(params: {
  accountId?: string | null;
  teamId?: string | null;
}): string {
  const accountId = normalizeOptionalScope(params.accountId);
  if (accountId) {
    return `account:${accountId}`;
  }
  const teamId = normalizeOptionalScope(params.teamId);
  if (teamId) {
    return `team:${teamId}`;
  }
  return `account:${DEFAULT_SLACK_ACCOUNT_SCOPE}`;
}

function resolveSlackMissionStoreKey(params: {
  missionId: string;
  accountId?: string | null;
  teamId?: string | null;
}): string {
  return JSON.stringify([resolveSlackMissionScope(params), params.missionId]);
}

async function readStore(
  storePath = getSlackMissionThreadStorePath(),
): Promise<SlackMissionThreadStore> {
  try {
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as SlackMissionThreadStore;
    return parsed && parsed.missions && typeof parsed.missions === "object"
      ? parsed
      : { missions: {} };
  } catch {
    return { missions: {} };
  }
}

async function writeStore(
  store: SlackMissionThreadStore,
  storePath = getSlackMissionThreadStorePath(),
): Promise<void> {
  await mkdir(path.dirname(storePath), { recursive: true });
  await writeFile(storePath, JSON.stringify(store, null, 2) + "\n", "utf8");
}

export async function persistSlackMissionThread(params: {
  missionId: string;
  accountId?: string | null;
  teamId?: string | null;
  channelId: string;
  threadTs: string;
  ownerAgent?: string;
  createdFromMessageTs?: string;
  storePath?: string;
}): Promise<SlackMissionThreadEntry> {
  const missionId = params.missionId.trim();
  const channelId = params.channelId.trim();
  const threadTs = params.threadTs.trim();
  if (!missionId || !channelId || !threadTs) {
    throw new Error("missionId, channelId, and threadTs are required");
  }

  const storePath = params.storePath ?? getSlackMissionThreadStorePath();
  const store = await readStore(storePath);
  const storeKey = resolveSlackMissionStoreKey({
    missionId,
    accountId: params.accountId,
    teamId: params.teamId,
  });
  const accountId = normalizeOptionalScope(params.accountId);
  const teamId = normalizeOptionalScope(params.teamId);
  const existing = store.missions[storeKey];
  const now = new Date().toISOString();
  const entry: SlackMissionThreadEntry = {
    platform: "slack",
    missionId,
    ...(accountId ? { accountId } : {}),
    ...(teamId ? { teamId } : {}),
    channelId,
    threadTs,
    ownerAgent: params.ownerAgent?.trim() || existing?.ownerAgent || "melvin",
    createdFromMessageTs:
      params.createdFromMessageTs?.trim() || existing?.createdFromMessageTs || threadTs,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    routingPolicy: "thread_required",
  };
  store.missions[storeKey] = entry;
  await writeStore(store, storePath);
  return entry;
}

export async function resolveSlackMissionThread(params: {
  missionId: string;
  accountId?: string | null;
  teamId?: string | null;
  channelId?: string;
  storePath?: string;
}): Promise<SlackMissionThreadEntry | undefined> {
  const missionId = params.missionId.trim();
  if (!missionId) {
    return undefined;
  }
  const store = await readStore(params.storePath ?? getSlackMissionThreadStorePath());
  const entry =
    store.missions[
      resolveSlackMissionStoreKey({
        missionId,
        accountId: params.accountId,
        teamId: params.teamId,
      })
    ];
  if (!entry) {
    return undefined;
  }
  const accountId = normalizeOptionalScope(params.accountId);
  if (accountId && entry.accountId && entry.accountId !== accountId) {
    return undefined;
  }
  const teamId = normalizeOptionalScope(params.teamId);
  if (teamId && entry.teamId && entry.teamId !== teamId) {
    return undefined;
  }
  if (params.channelId && entry.channelId !== params.channelId.trim()) {
    return undefined;
  }
  return entry;
}

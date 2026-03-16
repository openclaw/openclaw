import path from "node:path";
import { readJsonFile, withFileLock, writeJsonFile } from "./store-fs.js";

export type MSTeamsRecentChannelFocus = {
  provider: "msteams";
  target: string;
  label: string;
  teamLabel?: string;
  channelLabel?: string;
  resolution?: {
    teamLabelSource?: "activity" | "graph" | "config" | "id" | "missing";
    channelLabelSource?: "activity" | "graph" | "config" | "missing";
    graphTeamId?: string;
    graphAttempted?: boolean;
    graphTeamLookup?: "hit" | "miss" | "error" | "skipped";
    graphChannelLookup?: "hit" | "miss" | "error" | "skipped";
    graphChannelCandidates?: string[];
    configuredTeamLabel?: string;
    configuredChannelLabel?: string;
    lastError?: string;
  };
  teamId?: string;
  teamRuntimeId?: string;
  channelId?: string;
  conversationId?: string;
  tenantId?: string;
  updatedAt: string;
};

type MSTeamsChannelFocusStoreData = {
  version: 1;
  focusByMainSessionKey: Record<string, MSTeamsRecentChannelFocus>;
};

const STORE_FILENAME = "msteams-channel-focus.json";

function emptyStore(): MSTeamsChannelFocusStoreData {
  return {
    version: 1,
    focusByMainSessionKey: {},
  };
}

function normalizeSessionKey(sessionKey: string): string {
  return sessionKey.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeStoreData(value: unknown): MSTeamsChannelFocusStoreData {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.focusByMainSessionKey)) {
    return emptyStore();
  }
  return {
    version: 1,
    focusByMainSessionKey: Object.fromEntries(
      Object.entries(value.focusByMainSessionKey).filter(([, entry]) => isRecord(entry)),
    ),
  } as MSTeamsChannelFocusStoreData;
}

export function resolveMSTeamsChannelFocusStorePath(sessionStorePath: string): string {
  return path.join(path.dirname(path.resolve(sessionStorePath)), STORE_FILENAME);
}

export function buildMSTeamsRecentChannelFocusLabel(params: {
  target: string;
  teamLabel?: string;
  channelLabel?: string;
}): string {
  return [params.teamLabel, params.channelLabel].filter(Boolean).join(" / ") || params.target;
}

export async function readMSTeamsRecentChannelFocus(params: {
  sessionStorePath: string;
  mainSessionKey: string;
}): Promise<MSTeamsRecentChannelFocus | null> {
  const filePath = resolveMSTeamsChannelFocusStorePath(params.sessionStorePath);
  const { value } = await readJsonFile<MSTeamsChannelFocusStoreData>(filePath, emptyStore());
  const store = normalizeStoreData(value);
  const normalizedKey = normalizeSessionKey(params.mainSessionKey);
  const direct = store.focusByMainSessionKey[normalizedKey];
  if (direct) {
    return direct;
  }
  const fallback = Object.entries(store.focusByMainSessionKey).find(
    ([key]) => normalizeSessionKey(key) === normalizedKey,
  )?.[1];
  return fallback ?? null;
}

export async function writeMSTeamsRecentChannelFocus(params: {
  sessionStorePath: string;
  mainSessionKey: string;
  focus: Omit<MSTeamsRecentChannelFocus, "provider" | "updatedAt">;
}): Promise<void> {
  const filePath = resolveMSTeamsChannelFocusStorePath(params.sessionStorePath);
  const normalizedKey = normalizeSessionKey(params.mainSessionKey);
  await withFileLock(filePath, emptyStore(), async () => {
    const { value } = await readJsonFile<MSTeamsChannelFocusStoreData>(filePath, emptyStore());
    const store = normalizeStoreData(value);
    store.focusByMainSessionKey[normalizedKey] = {
      ...params.focus,
      provider: "msteams",
      updatedAt: new Date().toISOString(),
    };
    await writeJsonFile(filePath, store);
  });
}

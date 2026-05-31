import fs from "node:fs/promises";
import { getMSTeamsRuntime } from "./runtime.js";

/** Default cooldown between reflections per session (5 minutes). */
export const DEFAULT_COOLDOWN_MS = 300_000;

/** Tracks last reflection time per session to enforce cooldown. */
const lastReflectionBySession = new Map<string, number>();

/** Maximum cooldown entries before pruning expired ones. */
const MAX_COOLDOWN_ENTRIES = 500;
const LEARNINGS_NAMESPACE = "feedback-learnings";
const MAX_LEARNING_ENTRIES = 10_000;

type FeedbackLearningEntry = {
  sessionKey: string;
  learnings: string[];
  updatedAt: number;
};

function legacySanitizeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

function resolveLearningsFilePath(storePath: string, sessionKey: string): string {
  return `${storePath}/${encodeSessionKey(sessionKey)}.learnings.json`;
}

function resolveLegacyLearningsFilePath(storePath: string, sessionKey: string): string {
  return `${storePath}/${legacySanitizeSessionKey(sessionKey)}.learnings.json`;
}

function openLearningStore() {
  return getMSTeamsRuntime().state.openKeyedStore<FeedbackLearningEntry>({
    namespace: LEARNINGS_NAMESPACE,
    maxEntries: MAX_LEARNING_ENTRIES,
  });
}

async function readLearningsFile(
  filePath: string,
): Promise<{ exists: boolean; learnings: string[] }> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content);
    return { exists: true, learnings: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { exists: false, learnings: [] };
  }
}

async function importLegacyLearnings(params: {
  storePath: string;
  sessionKey: string;
}): Promise<string[]> {
  const learningsFile = resolveLearningsFilePath(params.storePath, params.sessionKey);
  const legacyLearningsFile = resolveLegacyLearningsFilePath(params.storePath, params.sessionKey);
  const { exists, learnings } = await readLearningsFile(learningsFile);
  const legacy =
    exists || legacyLearningsFile === learningsFile
      ? { exists: false, learnings: [] as string[] }
      : await readLearningsFile(legacyLearningsFile);
  const imported = [...learnings, ...legacy.learnings].slice(-10);
  if (imported.length === 0) {
    return [];
  }
  await openLearningStore().register(encodeSessionKey(params.sessionKey), {
    sessionKey: params.sessionKey,
    learnings: imported,
    updatedAt: Date.now(),
  });
  await fs.rm(learningsFile, { force: true }).catch(() => undefined);
  await fs.rm(legacyLearningsFile, { force: true }).catch(() => undefined);
  return imported;
}

/** Prune expired cooldown entries to prevent unbounded memory growth. */
function pruneExpiredCooldowns(cooldownMs: number): void {
  if (lastReflectionBySession.size <= MAX_COOLDOWN_ENTRIES) {
    return;
  }
  const now = Date.now();
  for (const [key, time] of lastReflectionBySession) {
    if (now - time >= cooldownMs) {
      lastReflectionBySession.delete(key);
    }
  }
}

/** Check if a reflection is allowed (cooldown not active). */
export function isReflectionAllowed(sessionKey: string, cooldownMs?: number): boolean {
  const cooldown = cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const lastTime = lastReflectionBySession.get(sessionKey);
  if (lastTime == null) {
    return true;
  }
  return Date.now() - lastTime >= cooldown;
}

/** Record that a reflection was run for a session. */
export function recordReflectionTime(sessionKey: string, cooldownMs?: number): void {
  lastReflectionBySession.set(sessionKey, Date.now());
  pruneExpiredCooldowns(cooldownMs ?? DEFAULT_COOLDOWN_MS);
}

/** Clear reflection cooldown tracking (for tests). */
export function clearReflectionCooldowns(): void {
  lastReflectionBySession.clear();
}

/** Store a learning derived from feedback reflection in a session companion file. */
export async function storeSessionLearning(params: {
  storePath: string;
  sessionKey: string;
  learning: string;
}): Promise<void> {
  const store = openLearningStore();
  const key = encodeSessionKey(params.sessionKey);
  const existing = await store.lookup(key);
  let learnings = existing?.learnings ?? (await importLegacyLearnings(params));
  learnings.push(params.learning);
  if (learnings.length > 10) {
    learnings = learnings.slice(-10);
  }
  await store.register(key, {
    sessionKey: params.sessionKey,
    learnings,
    updatedAt: Date.now(),
  });
}

/** Load session learnings for injection into extraSystemPrompt. */
export async function loadSessionLearnings(
  storePath: string,
  sessionKey: string,
): Promise<string[]> {
  const key = encodeSessionKey(sessionKey);
  const stored = await openLearningStore().lookup(key);
  if (stored) {
    return stored.learnings;
  }
  return await importLegacyLearnings({ storePath, sessionKey });
}

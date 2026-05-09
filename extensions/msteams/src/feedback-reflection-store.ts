import { createPluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

/** Default cooldown between reflections per session (5 minutes). */
export const DEFAULT_COOLDOWN_MS = 300_000;

/** Tracks last reflection time per session to enforce cooldown. */
const lastReflectionBySession = new Map<string, number>();

/** Maximum cooldown entries before pruning expired ones. */
const MAX_COOLDOWN_ENTRIES = 500;

function encodeSessionKey(sessionKey: string): string {
  return Buffer.from(sessionKey, "utf8").toString("base64url");
}

export function resolveLearningStoreKey(sessionKey: string): string {
  return encodeSessionKey(sessionKey);
}

const LEARNINGS_STORE = createPluginStateKeyedStore<{ learnings: string[]; updatedAt: number }>(
  "msteams",
  {
    namespace: "feedback-learnings",
    maxEntries: 50_000,
  },
);

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

/** Store a learning derived from feedback reflection in plugin state. */
export async function storeSessionLearning(params: {
  sessionKey: string;
  learning: string;
}): Promise<void> {
  const key = resolveLearningStoreKey(params.sessionKey);
  const existing = await LEARNINGS_STORE.lookup(key);
  let learnings = existing?.learnings ?? [];

  learnings.push(params.learning);
  if (learnings.length > 10) {
    learnings = learnings.slice(-10);
  }

  await LEARNINGS_STORE.register(key, { learnings, updatedAt: Date.now() });
}

/** Load session learnings for injection into extraSystemPrompt. */
export async function loadSessionLearnings(sessionKey: string): Promise<string[]> {
  const key = resolveLearningStoreKey(sessionKey);
  return (await LEARNINGS_STORE.lookup(key))?.learnings ?? [];
}

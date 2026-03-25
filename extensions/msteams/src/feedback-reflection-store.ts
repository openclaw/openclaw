/** Default cooldown between reflections per session (5 minutes). */
export const DEFAULT_COOLDOWN_MS = 300_000;

/** Tracks last reflection time per session to enforce cooldown. */
const lastReflectionBySession = new Map<string, number>();

/** Maximum cooldown entries before pruning expired ones. */
const MAX_COOLDOWN_ENTRIES = 500;

function sanitizeSessionKey(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9_-]/g, "_");
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
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const learningsFile = path.join(
    params.storePath,
    `${sanitizeSessionKey(params.sessionKey)}.learnings.json`,
  );

  let learnings: string[] = [];
  try {
    const existing = await fs.readFile(learningsFile, "utf-8");
    const parsed = JSON.parse(existing);
    if (Array.isArray(parsed)) {
      learnings = parsed;
    }
  } catch {
    // File doesn't exist yet — start fresh.
  }

  learnings.push(params.learning);
  if (learnings.length > 10) {
    learnings = learnings.slice(-10);
  }

  await fs.mkdir(path.dirname(learningsFile), { recursive: true });
  await fs.writeFile(learningsFile, JSON.stringify(learnings, null, 2), "utf-8");
}

/** Load session learnings for injection into extraSystemPrompt. */
export async function loadSessionLearnings(
  storePath: string,
  sessionKey: string,
): Promise<string[]> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");

  const learningsFile = path.join(storePath, `${sanitizeSessionKey(sessionKey)}.learnings.json`);

  try {
    const content = await fs.readFile(learningsFile, "utf-8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

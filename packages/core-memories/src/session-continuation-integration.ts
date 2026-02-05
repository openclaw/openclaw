import { CoreMemories, FlashEntry, KeywordSearchResult } from "./index";
import { SessionContinuation } from "./session-continuation";

export interface SessionContinuationIntegration {
  enabled: boolean;
  lastSessionFile: string;
}

export async function initSessionContinuation(
  coreMemories: CoreMemories,
  userId: string = "default",
): Promise<string | undefined> {
  try {
    const lastSession = await getLastSessionTime(userId);

    // Always record a timestamp for first-time users so future gaps can be computed.
    if (!lastSession) {
      await updateLastSessionTime(userId);
      return undefined;
    }

    const sc = new SessionContinuation(coreMemories);
    const result = await sc.checkSession(userId, lastSession.timestamp);

    await updateLastSessionTime(userId);

    return result.message;
  } catch {
    return undefined;
  }
}

export async function heartbeatSessionCheck(coreMemories: CoreMemories): Promise<void> {
  try {
    const flashEntries = coreMemories.getFlashEntries();
    const highSalience = flashEntries.filter((e: FlashEntry) => e.emotionalSalience > 0.8);

    if (highSalience.length > 0) {
      console.log(`${highSalience.length} high-priority memories pending`);
    }
  } catch {
    console.error("HEARTBEAT session check error");
  }
}

export async function getSmartReminderContext(
  coreMemories: CoreMemories,
  reminderTopic: string,
): Promise<string> {
  try {
    // Support both sync and async CoreMemories implementations.
    const flashResults: KeywordSearchResult = await Promise.resolve(
      coreMemories.findByKeyword(reminderTopic) as unknown as KeywordSearchResult,
    );

    if (flashResults.flash.length > 0) {
      const context = flashResults.flash
        .slice(0, 2)
        .map((r: FlashEntry) => r.content)
        .join(" ");
      return `Context: ${context}`;
    }

    return "";
  } catch {
    return "";
  }
}

interface SessionRecord {
  timestamp: number;
  gap?: number;
}

function resolveWorkspaceRoot(): string {
  return process.env.OPENCLAW_WORKSPACE || ".";
}

function resolveSessionDir(): string {
  // Store per-user session state to avoid clobber/race hazards with a shared JSON file.
  // (A single sessions.json is prone to lost updates when multiple processes write concurrently.)
  return [resolveWorkspaceRoot(), ".openclaw", "sessions"].join("/");
}

async function getLastSessionTime(userId: string): Promise<SessionRecord | null> {
  const fs = await import("fs/promises");
  const path = await import("path");

  // Preferred (race-safe): per-user file
  try {
    const sessionDir = path.resolve(resolveSessionDir());
    const userFile = path.join(sessionDir, `${userId}.json`);
    const data = await fs.readFile(userFile, "utf-8");
    return JSON.parse(data) as SessionRecord;
  } catch {
    // fall through
  }

  // Back-compat: legacy shared sessions.json
  try {
    const legacyFile = path.join(path.resolve(resolveWorkspaceRoot()), ".openclaw", "sessions.json");
    const data = await fs.readFile(legacyFile, "utf-8");
    const sessions = JSON.parse(data) as Record<string, SessionRecord>;
    return sessions[userId] || null;
  } catch {
    return null;
  }
}

async function atomicWriteFile(filePath: string, content: string): Promise<void> {
  const fs = await import("fs/promises");
  const path = await import("path");

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  await fs.writeFile(tmpPath, content);
  await fs.rename(tmpPath, filePath);
}

async function updateLastSessionTime(userId: string): Promise<void> {
  try {
    const path = await import("path");

    const sessionDir = path.resolve(resolveSessionDir());
    const userFile = path.join(sessionDir, `${userId}.json`);
    const record: SessionRecord = { timestamp: Date.now() };

    await atomicWriteFile(userFile, JSON.stringify(record, null, 2));
  } catch {
    console.error("Failed to update session time");
  }
}

export async function onSessionStart(
  coreMemories: CoreMemories,
  sendMessage: (msg: string) => void | Promise<void>,
): Promise<void> {
  const message = await initSessionContinuation(coreMemories, "default");

  if (message) {
    await Promise.resolve(sendMessage(message));
  }
}

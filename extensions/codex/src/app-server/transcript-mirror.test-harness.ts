import path from "node:path";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { readSessionTranscriptEvents } from "openclaw/plugin-sdk/session-transcript-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach } from "vitest";

/** Per-suite targets close their SQLite handles before releasing their temporary roots. */
export function createTranscriptMirrorTestHarness() {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterEach(async () => {
      for (const dir of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      cleanup();
    });
  });
  const makeRoot = (prefix: string) => tempDirs.make(prefix);

  async function createSqliteMirrorTarget(prefix: string, options: { sessionId?: string } = {}) {
    const root = makeRoot(prefix);
    const agentId = "main";
    const sessionId = options.sessionId ?? "session-1";
    const sessionKey = `agent:${agentId}:${sessionId}`;
    const storePath = path.join(root, "openclaw-agent.sqlite");
    await upsertSessionEntry({
      agentId,
      sessionKey,
      storePath,
      entry: {
        sessionFile: `sqlite:${agentId}:${sessionId}:${storePath}`,
        sessionId,
        updatedAt: 1,
      },
    });
    return {
      agentId,
      sessionId,
      sessionKey,
      storePath,
      bogusSessionFile: path.join(root, "should-not-be-created.jsonl"),
    };
  }

  return { makeRoot, createSqliteMirrorTarget };
}

function readEventMessages(events: unknown[]): Array<{ role?: string; text?: string }> {
  return events
    .map((event) =>
      event && typeof event === "object" ? (event as { message?: unknown }).message : undefined,
    )
    .filter((message): message is { role?: string; content?: unknown } =>
      Boolean(message && typeof message === "object"),
    )
    .map((message) => {
      const content = Array.isArray(message.content)
        ? message.content.find((part): part is { text: string } =>
            Boolean(part && typeof part === "object" && typeof part.text === "string"),
          )?.text
        : typeof message.content === "string"
          ? message.content
          : undefined;
      return { role: message.role, text: content };
    });
}

export async function readMirrorRaw(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<string> {
  return (await readSessionTranscriptEvents(target))
    .map((event) => JSON.stringify(event))
    .join("\n");
}

export async function readMirrorMessages(target: {
  agentId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}): Promise<Array<{ role?: string; text?: string }>> {
  return readEventMessages(await readSessionTranscriptEvents(target));
}

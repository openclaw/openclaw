import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readLocalClaudeTranscriptPage as readPage } from "./session-catalog.js";

const homes: string[] = [];
const originalHome = process.env.HOME;

afterEach(async () => {
  process.env.HOME = originalHome;
  await Promise.all(homes.splice(0).map((home) => fs.rm(home, { recursive: true, force: true })));
});

const row = (sessionId: string, type: "user" | "assistant", text: string, index: number) => ({
  type,
  sessionId,
  timestamp: `2026-07-0${index}T00:00:00.000Z`,
  isSidechain: false,
  message: { role: type, content: [{ type: "text", text }] },
});

async function writeUuidLessTranscript(
  home: string,
  sessionId: string,
  rows: Record<string, unknown>[],
): Promise<string> {
  const projectDir = path.join(home, ".claude", "projects", "-workspace");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "sessions-index.json"),
    JSON.stringify({
      version: 1,
      entries: [{ sessionId, fullPath: path.join(projectDir, `${sessionId}.jsonl`) }],
    }),
  );
  const transcript = path.join(projectDir, `${sessionId}.jsonl`);
  await fs.writeFile(transcript, `${rows.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return transcript;
}

// Issue #127378: uuid-less rows must anchor to append-stable byte offsets so
// catalog recovery re-imports dedupe instead of colliding on window indexes.
it("anchors uuid-less transcript rows to stable byte offsets for catalog import", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-claude-identity-"));
  homes.push(home);
  process.env.HOME = home;
  const sessionId = "rowless-session";
  const transcript = await writeUuidLessTranscript(home, sessionId, [
    row(sessionId, "user", "id-less prompt", 1),
    row(sessionId, "assistant", "id-less answer", 2),
  ]);

  const first = await readPage({ threadId: sessionId, limit: 10 }, home);
  const oldestUuid = first.items.at(-1)?.uuid;
  const newestUuid = first.items[0]?.uuid;
  // Byte offsets anchor recovery re-imports; native uuids stay untouched.
  expect(oldestUuid).toMatch(/^claude-row-\d+$/u);
  expect(newestUuid).toMatch(/^claude-row-\d+$/u);
  expect(newestUuid).not.toBe(oldestUuid);

  await fs.appendFile(transcript, `${JSON.stringify(row(sessionId, "user", "appended", 3))}\n`);
  const grown = await readPage({ threadId: sessionId, limit: 10 }, home);
  expect(grown.items.map((item) => item.uuid)).toEqual([
    expect.stringMatching(/^claude-row-\d+$/u),
    newestUuid,
    oldestUuid,
  ]);
  expect(grown.items[0]?.uuid).not.toBe(newestUuid);
});

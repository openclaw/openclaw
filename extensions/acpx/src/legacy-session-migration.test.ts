import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyAcpxSessions } from "./legacy-session-migration.js";
import { createFileSessionStore } from "./runtime.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acpx-legacy-migration-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

async function writeLegacySessionFile(stateDir: string, sessionId: string): Promise<string> {
  const sessionDir = path.join(stateDir, "sessions");
  await fs.mkdir(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `${encodeURIComponent(sessionId)}.json`);
  await fs.writeFile(
    filePath,
    `${JSON.stringify(
      {
        schema: "openclaw.acpx.session.v1",
        acpxRecordId: sessionId,
        acpSessionId: "acp-session-1",
        agentSessionId: "agent-session-1",
        agentCommand: "acpx agent",
        cwd: "/tmp/project",
        createdAt: "2026-04-05T08:00:00.000Z",
        lastUsedAt: "2026-04-05T08:01:00.000Z",
        lastSeq: 7,
        lastRequestId: "req-1",
        eventLog: {
          active_path: "/tmp/log",
          segment_count: 1,
          max_segment_bytes: 1024,
          max_segments: 4,
        },
        closed: false,
        title: "Legacy Session",
        messages: ["Resume"],
        updated_at: "2026-04-05T08:01:00.000Z",
        cumulative_token_usage: {
          input_tokens: 10,
          output_tokens: 20,
        },
        request_token_usage: {},
        acpx: {
          current_mode_id: "default",
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return filePath;
}

describe("migrateLegacyAcpxSessions", () => {
  it("rewrites legacy OpenClaw ACPX session files into the acpx runtime schema", async () => {
    const stateDir = await makeTempDir();
    const sessionId = "legacy/session";
    const filePath = await writeLegacySessionFile(stateDir, sessionId);

    await migrateLegacyAcpxSessions({ stateDir });

    const payload = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    expect(payload.schema).toBe("acpx.session.v1");
    expect(payload.acpx_record_id).toBe(sessionId);

    const store = createFileSessionStore({ stateDir });
    await expect(store.load(sessionId)).resolves.toMatchObject({
      acpxRecordId: sessionId,
      acpSessionId: "acp-session-1",
      agentSessionId: "agent-session-1",
      lastSeq: 7,
      messages: ["Resume"],
    });
  });

  it("warns and keeps starting when a legacy session file cannot be migrated", async () => {
    const stateDir = await makeTempDir();
    const sessionDir = path.join(stateDir, "sessions");
    await fs.mkdir(sessionDir, { recursive: true });
    await fs.writeFile(path.join(sessionDir, "broken.json"), "{not-json}\n", "utf8");

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    await expect(migrateLegacyAcpxSessions({ stateDir, logger })).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to migrate legacy ACPX session file broken.json"),
    );
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

const scheduleSessionManagerSyncToPostgres = vi.fn((_params?: unknown) => undefined);
const scheduleSessionManagerTailSyncToPostgres = vi.fn((_params?: unknown) => undefined);

vi.mock("../persistence/service.js", () => ({
  scheduleSessionManagerSyncToPostgres: (params: unknown) =>
    scheduleSessionManagerSyncToPostgres(params),
  scheduleSessionManagerTailSyncToPostgres: (params: unknown) =>
    scheduleSessionManagerTailSyncToPostgres(params),
}));

const { guardSessionManager } = await import("./session-tool-result-guard-wrapper.js");

describe("guardSessionManager persistence mirror", () => {
  let tempDir = "";

  afterEach(async () => {
    scheduleSessionManagerSyncToPostgres.mockReset();
    scheduleSessionManagerTailSyncToPostgres.mockReset();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = "";
    }
  });

  it("mirrors transcript appends after wrapping a file-backed session manager", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-guard-persistence-"));
    const sessionFile = path.join(tempDir, "session.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 1,
        id: "session-1",
        timestamp: new Date().toISOString(),
        cwd: tempDir,
      })}\n`,
      "utf8",
    );

    const sessionManager = guardSessionManager(SessionManager.open(sessionFile), {
      agentId: "main",
    });
    sessionManager.appendMessage({
      role: "user",
      content: "hello",
      timestamp: Date.now(),
    });

    expect(scheduleSessionManagerSyncToPostgres).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptPath: sessionFile,
        agentId: "main",
      }),
    );
    expect(scheduleSessionManagerTailSyncToPostgres).toHaveBeenCalledWith(
      expect.objectContaining({
        transcriptPath: sessionFile,
        agentId: "main",
      }),
    );
  });
});

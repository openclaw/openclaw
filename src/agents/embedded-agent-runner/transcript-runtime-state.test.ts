import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  upsertSessionEntry,
} from "../../config/sessions/session-accessor.js";
import {
  deleteRuntimeTranscript,
  readRuntimeTranscriptState,
  runtimeTranscriptExists,
} from "./transcript-runtime-state.js";

describe("runtime transcript state", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-runtime-transcript-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("reads and deletes transcript state through runtime scope", async () => {
    const scope = {
      agentId: "main",
      sessionId: "session-1",
      sessionKey: "agent:main:main",
      storePath,
    };

    await upsertSessionEntry(scope, {
      sessionId: scope.sessionId,
      updatedAt: 10,
    });
    await appendTranscriptMessage(scope, {
      cwd: tempDir,
      message: {
        content: "hello",
        role: "user",
      },
    });

    await expect(runtimeTranscriptExists(scope)).resolves.toBe(true);
    const { state, target } = await readRuntimeTranscriptState(scope);
    expect(fs.realpathSync(target.sessionFile)).toBe(
      fs.realpathSync(path.join(tempDir, "session-1.jsonl")),
    );
    expect(state.getBranch()).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({ content: "hello" }),
        type: "message",
      }),
    ]);

    await expect(deleteRuntimeTranscript(scope)).resolves.toBe(true);
    await expect(runtimeTranscriptExists(scope)).resolves.toBe(false);
  });

  it("does not create session metadata for missing transcript probes", async () => {
    const scope = {
      agentId: "main",
      sessionId: "missing-session",
      sessionKey: "agent:main:missing",
      storePath,
    };
    fs.writeFileSync(storePath, "{}\n", "utf8");

    await expect(runtimeTranscriptExists(scope)).resolves.toBe(false);
    await expect(deleteRuntimeTranscript(scope)).resolves.toBe(false);

    expect(fs.readFileSync(storePath, "utf8")).toBe("{}\n");
  });

  it("does not create session metadata when reading a missing transcript", async () => {
    const scope = {
      agentId: "main",
      sessionId: "missing-session",
      sessionKey: "agent:main:missing",
      storePath,
    };
    fs.writeFileSync(storePath, "{}\n", "utf8");

    await expect(readRuntimeTranscriptState(scope)).rejects.toThrow();

    expect(fs.readFileSync(storePath, "utf8")).toBe("{}\n");
  });

  it("does not delete a stale transcript from a previous session id", async () => {
    const oldTranscriptPath = path.join(tempDir, "old-session.jsonl");
    fs.writeFileSync(
      storePath,
      JSON.stringify({
        "agent:main:main": {
          sessionFile: "old-session.jsonl",
          sessionId: "old-session",
          updatedAt: 10,
        },
      }) + "\n",
      "utf8",
    );
    fs.writeFileSync(oldTranscriptPath, '{"type":"session","id":"old-session"}\n', "utf8");

    const scope = {
      agentId: "main",
      sessionId: "new-session",
      sessionKey: "agent:main:main",
      storePath,
    };

    await expect(runtimeTranscriptExists(scope)).resolves.toBe(false);
    await expect(deleteRuntimeTranscript(scope)).resolves.toBe(false);

    expect(fs.existsSync(oldTranscriptPath)).toBe(true);
  });
});

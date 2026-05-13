import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MessagePort } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { AgentFilesystemMode, PreparedAgentRun } from "./runtime-backend.js";
import { createWorkerFilesystem, createWorkerRuntimeContext } from "./runtime-worker.entry.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-worker-entry-"));
}

function createPreparedRun(
  filesystemMode: AgentFilesystemMode,
  overrides: Partial<PreparedAgentRun> = {},
): PreparedAgentRun {
  return {
    runtimeId: "test",
    runId: `run-${filesystemMode}`,
    agentId: "main",
    sessionId: "session-worker",
    sessionKey: "agent:main:main",
    workspaceDir: "/tmp/workspace",
    prompt: "hello",
    timeoutMs: 1000,
    filesystemMode,
    deliveryPolicy: { emitToolResult: false, emitToolOutput: false },
    ...overrides,
  };
}

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
});

describe("agent runtime worker entry filesystem", () => {
  it.each(["disk", "vfs-scratch"] as const)(
    "keeps host workspace access for %s mode while using SQLite scratch storage",
    async (filesystemMode) => {
      process.env.OPENCLAW_STATE_DIR = createTempStateDir();

      const filesystem = await createWorkerFilesystem(createPreparedRun(filesystemMode));
      filesystem.scratch.writeFile("/scratch/output.txt", "hello", {
        metadata: { source: filesystemMode },
      });
      const artifact = filesystem.artifacts?.write({
        kind: "worker/test",
        blob: "artifact",
        metadata: { source: filesystemMode },
      });
      const runArtifact = filesystem.runArtifacts?.write({
        path: "reports/output.txt",
        kind: "worker/report",
        blob: "report",
        metadata: { source: filesystemMode },
      });

      expect(filesystem.workspace).toEqual({ root: "/tmp/workspace" });
      expect(filesystem.scratch.readFile("/scratch/output.txt").toString("utf8")).toBe("hello");
      expect(filesystem.scratch.stat("/scratch/output.txt")).toMatchObject({
        metadata: { source: filesystemMode },
        size: 5,
      });
      expect(artifact).toMatchObject({
        agentId: "main",
        runId: `run-${filesystemMode}`,
        kind: "worker/test",
        size: 8,
      });
      expect(runArtifact).toMatchObject({
        agentId: "main",
        runId: `run-${filesystemMode}`,
        path: "/reports/output.txt",
        kind: "worker/report",
        size: 6,
      });
      expect(filesystem.runArtifacts?.read("/reports/output.txt")).toMatchObject({
        blobBase64: "cmVwb3J0",
      });
    },
  );

  it("removes host workspace access for vfs-only mode", async () => {
    process.env.OPENCLAW_STATE_DIR = createTempStateDir();

    const filesystem = await createWorkerFilesystem(createPreparedRun("vfs-only"));
    filesystem.scratch.writeFile("/only.txt", "vfs");

    expect(filesystem.workspace).toBeUndefined();
    expect(filesystem.scratch.readFile("/only.txt").toString("utf8")).toBe("vfs");
  });

  it("seeds initial files into the SQLite VFS before vfs-only tools run", async () => {
    process.env.OPENCLAW_STATE_DIR = createTempStateDir();

    const filesystem = await createWorkerFilesystem(
      createPreparedRun("vfs-only", {
        initialVfsEntries: [
          {
            path: ".openclaw/attachments/seed/file.txt",
            contentBase64: Buffer.from("seeded").toString("base64"),
            metadata: { source: "test" },
          },
        ],
      }),
    );

    expect(
      filesystem.scratch.readFile("/.openclaw/attachments/seed/file.txt").toString("utf8"),
    ).toBe("seeded");
    expect(filesystem.scratch.stat("/.openclaw/attachments/seed/file.txt")).toMatchObject({
      metadata: { source: "test" },
      size: 6,
    });
  });
});

describe("agent runtime worker entry control", () => {
  it("provides a child abort signal and aborts it when the parent sends cancel", async () => {
    process.env.OPENCLAW_STATE_DIR = createTempStateDir();
    const handlers: ((message: unknown) => void)[] = [];
    const port = {
      on(event: string, handler: (message: unknown) => void) {
        if (event === "message") {
          handlers.push(handler);
        }
        return this;
      },
    } as unknown as MessagePort;
    const context = await createWorkerRuntimeContext(createPreparedRun("vfs-scratch"), {
      port,
    });
    context.cache?.write({
      key: "plan",
      value: { ok: true },
      blob: "cached",
      ttlMs: 60_000,
    });
    const messages: unknown[] = [];
    context.control?.onMessage((message) => {
      messages.push(message);
    });

    handlers.forEach((handler) => {
      handler({ type: "control", message: { type: "queue_message", text: "keep going" } });
    });
    expect(context.signal?.aborted).toBe(false);

    handlers.forEach((handler) => {
      handler({ type: "control", message: { type: "cancel", reason: "user_abort" } });
    });

    expect(context.signal?.aborted).toBe(true);
    expect(context.signal?.reason).toEqual(expect.any(Error));
    expect(context.cache?.read("plan")).toMatchObject({
      agentId: "main",
      scope: "run:run-vfs-scratch",
      key: "plan",
      value: { ok: true },
      blob: Buffer.from("cached"),
    });
    expect(messages).toEqual([
      { type: "queue_message", text: "keep going" },
      { type: "cancel", reason: "user_abort" },
    ]);
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetPluginBlobStoreForTests } from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFileConsentActivityPersistent } from "./file-consent-helpers.js";
import {
  getPendingUploadState,
  removePendingUploadState,
  setPendingUploadActivityIdState,
  storePendingUploadState,
} from "./pending-uploads-state.js";
import { clearPendingUploads } from "./pending-uploads.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-runtime.js";

// Track temp dirs created by each test so afterEach can clean them up.
const createdTempDirs: string[] = [];

async function makeTempStateDir(): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-pending-"));
  createdTempDirs.push(dir);
  return dir;
}

function makeEnv(stateDir: string): NodeJS.ProcessEnv {
  return { ...process.env, OPENCLAW_STATE_DIR: stateDir };
}

async function cleanupTempDirs(): Promise<void> {
  while (createdTempDirs.length > 0) {
    const dir = createdTempDirs.pop();
    if (!dir) {
      continue;
    }
    try {
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch {
      // tmp dir may already be gone
    }
  }
}

describe("msteams pending uploads (sqlite-backed)", () => {
  beforeEach(() => {
    resetPluginBlobStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
    clearPendingUploads();
  });

  afterEach(async () => {
    await cleanupTempDirs();
    vi.useRealTimers();
  });

  it("stores and retrieves a pending upload by id", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    await storePendingUploadState(
      {
        id: "upload-1",
        buffer: Buffer.from("hello world"),
        filename: "greeting.txt",
        contentType: "text/plain",
        conversationId: "19:conv@thread.v2",
      },
      { env },
    );

    const loaded = await getPendingUploadState("upload-1", { env });
    expect(loaded).toBeDefined();
    expect(loaded?.id).toBe("upload-1");
    expect(loaded?.filename).toBe("greeting.txt");
    expect(loaded?.contentType).toBe("text/plain");
    expect(loaded?.conversationId).toBe("19:conv@thread.v2");
    expect(loaded?.buffer.toString("utf8")).toBe("hello world");
  });

  it("returns undefined for missing and undefined ids", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    expect(await getPendingUploadState(undefined, { env })).toBeUndefined();
    expect(await getPendingUploadState("does-not-exist", { env })).toBeUndefined();
  });

  it("persists so another reader finds the entry (simulates cross-process)", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    // First "process": writer
    await storePendingUploadState(
      {
        id: "upload-x",
        buffer: Buffer.from("top secret"),
        filename: "secret.bin",
        conversationId: "19:conv@thread.v2",
      },
      { env },
    );

    // Confirm the old JSON sidecar is no longer written.
    const storePath = path.join(stateDir, "msteams-pending-uploads.json");
    expect(fs.existsSync(storePath)).toBe(false);
    expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(true);

    // Second "process": reader using the same state dir
    const reader = await getPendingUploadState("upload-x", { env });
    expect(reader?.buffer.toString("utf8")).toBe("top secret");
    expect(reader?.filename).toBe("secret.bin");
  });

  it("removes persisted entries", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    await storePendingUploadState(
      {
        id: "upload-rm",
        buffer: Buffer.from("x"),
        filename: "rm.bin",
        conversationId: "19:conv@thread.v2",
      },
      { env },
    );
    expect(await getPendingUploadState("upload-rm", { env })).toBeDefined();

    await removePendingUploadState("upload-rm", { env });
    expect(await getPendingUploadState("upload-rm", { env })).toBeUndefined();
  });

  it("remove is a no-op for unknown ids", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    await expect(removePendingUploadState("never-existed", { env })).resolves.toBeUndefined();
    await expect(removePendingUploadState(undefined, { env })).resolves.toBeUndefined();
  });

  it("expires entries past their ttl on read", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);
    const now = new Date("2026-05-08T00:00:00.000Z");
    vi.useFakeTimers({ now });

    await storePendingUploadState(
      {
        id: "upload-old",
        buffer: Buffer.from("stale"),
        filename: "stale.txt",
        conversationId: "19:conv@thread.v2",
      },
      { env, ttlMs: 1 },
    );
    vi.setSystemTime(now.getTime() + 2);
    expect(await getPendingUploadState("upload-old", { env, ttlMs: 1 })).toBeUndefined();
  });

  it("updates consent card activity id on an existing entry", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);

    await storePendingUploadState(
      {
        id: "upload-a",
        buffer: Buffer.from("payload"),
        filename: "f.txt",
        conversationId: "19:conv@thread.v2",
      },
      { env },
    );

    await setPendingUploadActivityIdState("upload-a", "activity-xyz", { env });
    const loaded = await getPendingUploadState("upload-a", { env });
    expect(loaded?.consentCardActivityId).toBe("activity-xyz");
  });

  it("ignores leftover legacy JSON files at runtime", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);
    const storePath = path.join(stateDir, "msteams-pending-uploads.json");
    await fs.promises.writeFile(storePath, "not valid json", "utf-8");

    expect(await getPendingUploadState("anything", { env })).toBeUndefined();
  });
});

describe("prepareFileConsentActivityPersistent end-to-end", () => {
  beforeEach(() => {
    resetPluginBlobStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
    clearPendingUploads();
  });

  afterEach(async () => {
    await cleanupTempDirs();
  });

  it("writes the pending upload to SQLite with the same id as the card", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);
    // Redirect state dir via env so the helper's SQLite writes land under our tmp
    const originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const result = await prepareFileConsentActivityPersistent({
        media: {
          buffer: Buffer.from("cli file"),
          filename: "cli.bin",
          contentType: "application/octet-stream",
        },
        conversationId: "19:victim@thread.v2",
        description: "Sent via CLI",
      });

      expect(result.uploadId).toMatch(/[0-9a-f-]/);
      const attachments = result.activity.attachments as Array<Record<string, unknown>>;
      expect(attachments).toHaveLength(1);
      const content = attachments[0]?.content as { acceptContext: { uploadId: string } };
      expect(content.acceptContext.uploadId).toBe(result.uploadId);

      // Reader in (simulated) other process finds the entry under the same key
      const loaded = await getPendingUploadState(result.uploadId, { env });
      expect(loaded).toBeDefined();
      expect(loaded?.filename).toBe("cli.bin");
      expect(loaded?.contentType).toBe("application/octet-stream");
      expect(loaded?.conversationId).toBe("19:victim@thread.v2");
      expect(loaded?.buffer.toString("utf8")).toBe("cli file");
    } finally {
      if (originalEnv === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = originalEnv;
      }
    }
  });
});

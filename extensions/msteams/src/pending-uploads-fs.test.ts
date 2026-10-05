import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  openOpenClawStateDatabase,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareFileConsentActivityFs } from "./file-consent-helpers.js";
import {
  getPendingUploadFs,
  removePendingUploadFs,
  setPendingUploadActivityIdFs,
  storePendingUploadFs,
} from "./pending-uploads-fs.js";
import { setMSTeamsRuntime } from "./runtime.js";
import { msteamsRuntimeStub } from "./test-support/runtime.js";

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

function storeUpload(
  env: NodeJS.ProcessEnv,
  upload: Pick<Parameters<typeof storePendingUploadFs>[0], "id"> &
    Partial<Parameters<typeof storePendingUploadFs>[0]>,
  options: { ttlMs?: number } = {},
) {
  return storePendingUploadFs(
    {
      buffer: Buffer.from("payload"),
      filename: "f.txt",
      conversationId: "19:conv@thread.v2",
      ...upload,
    },
    { env, ...options },
  );
}

async function requirePendingUpload(id: string, env: NodeJS.ProcessEnv) {
  const upload = await getPendingUploadFs(id, { env });
  if (!upload) {
    throw new Error(`expected pending upload ${id}`);
  }
  return upload;
}

async function cleanupTempDirs(): Promise<void> {
  await closeOpenClawStateDatabaseAsync();
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

describe("msteams pending uploads (fs-backed)", () => {
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
    stateDir = await makeTempStateDir();
    env = makeEnv(stateDir);
  });

  afterEach(async () => {
    await cleanupTempDirs();
    vi.useRealTimers();
  });

  it("returns undefined for missing and undefined ids", async () => {
    expect(await getPendingUploadFs(undefined, { env })).toBeUndefined();
    expect(await getPendingUploadFs("does-not-exist", { env })).toBeUndefined();
  });

  it("persists so another reader finds the entry (simulates cross-process)", async () => {
    await storeUpload(env, {
      id: "upload-x",
      buffer: Buffer.from("top secret"),
      filename: "secret.bin",
    });

    // Confirm SQLite-backed plugin state was created instead of a new JSON store.
    const storePath = path.join(stateDir, "msteams-pending-uploads.json");
    await expect(fs.promises.access(storePath)).rejects.toThrow();
    await fs.promises.access(path.join(stateDir, "state", "openclaw.sqlite"));

    const reader = await getPendingUploadFs("upload-x", { env });
    expect(reader?.buffer.toString("utf8")).toBe("top secret");
    expect(reader?.filename).toBe("secret.bin");
  });

  it.each(["bulk", "legacy"])("stores multi-megabyte uploads with %s host reads", async (mode) => {
    if (mode === "legacy") {
      setMSTeamsRuntime({
        ...msteamsRuntimeStub,
        state: {
          ...msteamsRuntimeStub.state,
          openKeyedStore: <T>(options: OpenAsyncKeyedStoreOptions) => {
            const { lookupMany: _lookupMany, ...store } = createPluginStateKeyedStoreForTests<T>(
              "msteams",
              options,
            );
            return store;
          },
        },
      });
    }
    const payload = Buffer.alloc(6 * 1024 * 1024, 7);

    await storeUpload(env, { id: "upload-large", buffer: payload, filename: "large.bin" });

    const reader = await getPendingUploadFs("upload-large", { env });
    expect(reader?.buffer.equals(payload)).toBe(true);
    expect(reader?.filename).toBe("large.bin");
    const chunks = createPluginStateKeyedStoreForTests<{
      id: string;
      index: number;
      dataBase64: string;
    }>("msteams", { namespace: "pending-upload-chunks", maxEntries: 45_000, env });
    const rows = await chunks.entries();
    const first = rows.find((row) => row.value.index === 0);
    const later = rows.find((row) => row.value.index === 1);
    if (!first || !later) {
      throw new Error("expected upload chunks");
    }
    const { db } = openOpenClawStateDatabase({ env });
    db.prepare("UPDATE plugin_state_entries SET value_json = ? WHERE entry_key = ?").run(
      "invalid JSON",
      later.key,
    );
    await chunks.register(first.key, { ...first.value, id: "wrong-upload" });
    await expect(getPendingUploadFs("upload-large", { env })).resolves.toBeUndefined();
    await chunks.delete(first.key);
    await expect(getPendingUploadFs("upload-large", { env })).resolves.toBeUndefined();
    await chunks.register(first.key, first.value);
    await expect(getPendingUploadFs("upload-large", { env })).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
    });
  });

  it("removes persisted entries", async () => {
    await storeUpload(env, { id: "upload-rm", buffer: Buffer.from("x"), filename: "rm.bin" });
    const loaded = await requirePendingUpload("upload-rm", env);
    expect(loaded.id).toBe("upload-rm");
    expect(loaded.filename).toBe("rm.bin");
    expect(loaded.contentType).toBeUndefined();
    expect(loaded.conversationId).toBe("19:conv@thread.v2");
    expect(loaded.consentCardActivityId).toBeUndefined();
    expect(loaded.buffer.toString("utf8")).toBe("x");
    expect(Number.isFinite(loaded.createdAt)).toBe(true);

    await removePendingUploadFs("upload-rm", { env });
    expect(await getPendingUploadFs("upload-rm", { env })).toBeUndefined();
  });

  it("remove is a no-op for unknown ids", async () => {
    await expect(removePendingUploadFs("never-existed", { env })).resolves.toBeUndefined();
    await expect(removePendingUploadFs(undefined, { env })).resolves.toBeUndefined();
  });

  it("expires entries past their ttl on read", async () => {
    const now = new Date("2026-05-08T00:00:00.000Z");
    vi.useFakeTimers({ now });

    await storeUpload(env, { id: "upload-old" }, { ttlMs: 1 });
    vi.setSystemTime(now.getTime() + 2);
    expect(await getPendingUploadFs("upload-old", { env, ttlMs: 1 })).toBeUndefined();
  });

  it("updates consent card activity id on an existing entry", async () => {
    await storeUpload(env, { id: "upload-a" });

    await setPendingUploadActivityIdFs("upload-a", "activity-xyz", { env });
    const loaded = await getPendingUploadFs("upload-a", { env });
    expect(loaded?.consentCardActivityId).toBe("activity-xyz");
  });

  it("ignores legacy pending-upload JSON cache files at runtime", async () => {
    const storePath = path.join(stateDir, "msteams-pending-uploads.json");
    await fs.promises.writeFile(
      storePath,
      `${JSON.stringify({
        version: 1,
        uploads: {
          cached: {
            id: "cached",
            bufferBase64: Buffer.from("cached payload").toString("base64"),
            filename: "cached.txt",
            conversationId: "19:conv@thread.v2",
            createdAt: Date.now(),
          },
        },
      })}\n`,
      "utf-8",
    );

    expect(await getPendingUploadFs("cached", { env })).toBeUndefined();
    await fs.promises.access(storePath);
  });
});

describe("prepareFileConsentActivityFs end-to-end", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    setMSTeamsRuntime(msteamsRuntimeStub);
  });

  it("writes the pending upload to the fs store with the same id as the card", async () => {
    const stateDir = await makeTempStateDir();
    const env = makeEnv(stateDir);
    // Redirect state dir via env so the helper's FS writes land under our tmp
    const originalEnv = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = stateDir;

    try {
      const result = await prepareFileConsentActivityFs({
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
      const loaded = await requirePendingUpload(result.uploadId, env);
      expect(loaded.filename).toBe("cli.bin");
      expect(loaded.contentType).toBe("application/octet-stream");
      expect(loaded.conversationId).toBe("19:victim@thread.v2");
      expect(loaded.buffer.toString("utf8")).toBe("cli file");
    } finally {
      try {
        await cleanupTempDirs();
      } finally {
        if (originalEnv === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = originalEnv;
        }
      }
    }
  });
});

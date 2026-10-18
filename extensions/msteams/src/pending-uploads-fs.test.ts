import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

let stateDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  resetPluginStateStoreForTests();
  setMSTeamsRuntime(msteamsRuntimeStub);
  stateDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-msteams-pending-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  try {
    await fs.promises.rm(stateDir, { recursive: true, force: true });
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  }
});

function storeUpload(
  upload: Pick<Parameters<typeof storePendingUploadFs>[0], "id"> &
    Partial<Parameters<typeof storePendingUploadFs>[0]>,
) {
  return storePendingUploadFs({
    buffer: Buffer.from("payload"),
    filename: "f.txt",
    conversationId: "19:conv@thread.v2",
    ...upload,
  });
}

describe("msteams pending uploads (fs-backed)", () => {
  it("returns undefined for missing and undefined ids", async () => {
    expect(await getPendingUploadFs(undefined)).toBeUndefined();
    expect(await getPendingUploadFs("does-not-exist")).toBeUndefined();
  });

  it("stores multi-megabyte uploads with bulk reads", async () => {
    const payload = Buffer.alloc(6 * 1024 * 1024, 7);

    await storeUpload({ id: "upload-large", buffer: payload, filename: "large.bin" });

    const reader = await getPendingUploadFs("upload-large");
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
    await expect(getPendingUploadFs("upload-large")).resolves.toBeUndefined();
    await chunks.delete(first.key);
    await expect(getPendingUploadFs("upload-large")).resolves.toBeUndefined();
    await chunks.register(first.key, first.value);
    await expect(getPendingUploadFs("upload-large")).rejects.toMatchObject({
      code: "PLUGIN_STATE_CORRUPT",
    });
  });

  it("remove is a no-op for unknown ids", async () => {
    await expect(removePendingUploadFs("never-existed")).resolves.toBeUndefined();
    await expect(removePendingUploadFs(undefined)).resolves.toBeUndefined();
  });

  it("expires entries past their ttl on read", async () => {
    const now = new Date("2026-05-08T00:00:00.000Z");
    vi.useFakeTimers({ now });

    await storeUpload({ id: "upload-old" });
    vi.setSystemTime(now.getTime() + 5 * 60 * 1000 + 1);
    expect(await getPendingUploadFs("upload-old")).toBeUndefined();
  });

  it("updates consent card activity id on an existing entry", async () => {
    await storeUpload({ id: "upload-a" });

    await setPendingUploadActivityIdFs("upload-a", "activity-xyz");
    const loaded = await getPendingUploadFs("upload-a");
    expect(loaded?.consentCardActivityId).toBe("activity-xyz");
  });
});

describe("prepareFileConsentActivityFs end-to-end", () => {
  it("writes the pending upload to the fs store with the same id as the card", async () => {
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

    const loaded = await getPendingUploadFs(result.uploadId);
    expect(loaded).toMatchObject({
      filename: "cli.bin",
      contentType: "application/octet-stream",
      conversationId: "19:victim@thread.v2",
    });
    expect(loaded?.buffer.toString("utf8")).toBe("cli file");
  });
});

import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { BROWSER_PROXY_UPLOAD_ENVELOPE } from "./browser-proxy-envelope.js";
import {
  discardStagedBrowserProxyUpload,
  ensureBrowserProxyUploadCleanup,
  hasBrowserProxyUploadWork,
  stageBrowserProxyUploadRequest,
} from "./browser-proxy-upload.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const RETRY_MS = 60 * 60 * 1000;
const MARKER = ".openclaw-browser-proxy-upload-v1";
const chmodFaultUnavailable = process.platform === "win32" || process.getuid?.() === 0;

function stage(uploadDir: string) {
  return stageBrowserProxyUploadRequest({
    method: "POST",
    path: "/hooks/file-chooser",
    body: { ref: "e1" },
    upload: {
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [{ name: "report.txt", contentBase64: Buffer.from("report").toString("base64") }],
    },
    uploadDir,
  });
}

it("keeps filesystem operations busy without treating retained files as active work", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const uploadDir = tempDirs.make("openclaw-browser-upload-idle-");
  let staged: Awaited<ReturnType<typeof stage>> | undefined;
  try {
    expect(hasBrowserProxyUploadWork()).toBe(false);
    const recovery = ensureBrowserProxyUploadCleanup({ uploadDir });
    expect(hasBrowserProxyUploadWork()).toBe(true);
    await recovery;
    expect(hasBrowserProxyUploadWork()).toBe(false);

    staged = await stage(uploadDir);
    expect(hasBrowserProxyUploadWork()).toBe(false);
    await expect(
      fs.readFile(path.join(staged.directory!, "0", "report.txt"), "utf8"),
    ).resolves.toBe("report");

    const cleanup = discardStagedBrowserProxyUpload(staged);
    expect(hasBrowserProxyUploadWork()).toBe(true);
    await cleanup;
    expect(hasBrowserProxyUploadWork()).toBe(false);

    staged = await stage(uploadDir);
    const retainedDirectory = staged.directory!;
    await vi.advanceTimersByTimeAsync(24 * RETRY_MS);
    await vi.waitFor(async () => {
      await expect(fs.stat(retainedDirectory)).rejects.toHaveProperty("code", "ENOENT");
      expect(hasBrowserProxyUploadWork()).toBe(false);
    });
  } finally {
    if (staged) {
      await discardStagedBrowserProxyUpload(staged);
    }
    vi.useRealTimers();
  }
});

it.skipIf(chmodFaultUnavailable)(
  "paces failed recovery and retries repaired storage before upload admission",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const uploadDir = tempDirs.make("openclaw-browser-upload-recovery-");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const expired = path.join(stagingRoot, "upload-expired");
    await fs.mkdir(expired, { recursive: true });
    await fs.writeFile(path.join(expired, MARKER), "openclaw-browser-proxy-upload-v1\n");
    const past = new Date(Date.now() - 25 * RETRY_MS);
    await fs.utimes(expired, past, past);
    await fs.chmod(stagingRoot, 0o000);
    const reads = vi.spyOn(fs, "readdir");
    const recoveryReads = () =>
      reads.mock.calls.filter(([target]) => target === stagingRoot).length;
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await ensureBrowserProxyUploadCleanup({ uploadDir });
      }
      expect(recoveryReads()).toBe(1);
      expect(hasBrowserProxyUploadWork()).toBe(false);

      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await vi.waitFor(() => expect(hasBrowserProxyUploadWork()).toBe(false));
      for (let attempt = 0; attempt < 5; attempt++) {
        await ensureBrowserProxyUploadCleanup({ uploadDir });
      }
      expect(recoveryReads()).toBe(2);

      await fs.chmod(stagingRoot, 0o700);
      const staged = await stage(uploadDir);
      try {
        await expect(fs.stat(expired)).rejects.toHaveProperty("code", "ENOENT");
        expect(hasBrowserProxyUploadWork()).toBe(false);
      } finally {
        await discardStagedBrowserProxyUpload(staged);
      }
    } finally {
      reads.mockRestore();
      await fs.chmod(stagingRoot, 0o700);
      await ensureBrowserProxyUploadCleanup({ uploadDir, retentionMs: 0 });
      vi.useRealTimers();
    }
  },
);

it.skipIf(chmodFaultUnavailable)(
  "keeps failed deletion recoverable and retries without blocking idle admission",
  async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const uploadDir = tempDirs.make("openclaw-browser-upload-cleanup-");
    const staged = await stage(uploadDir);
    const directory = staged.directory!;
    const child = path.join(directory, "0");
    await fs.chmod(child, 0o500);
    try {
      const cleanup = discardStagedBrowserProxyUpload(staged);
      expect(hasBrowserProxyUploadWork()).toBe(true);
      await cleanup;
      await expect(fs.readFile(path.join(directory, MARKER), "utf8")).resolves.toBe(
        "openclaw-browser-proxy-upload-v1\n",
      );
      await expect(fs.readFile(path.join(child, "report.txt"), "utf8")).resolves.toBe("report");
      expect(hasBrowserProxyUploadWork()).toBe(false);

      await fs.chmod(child, 0o700);
      await vi.advanceTimersByTimeAsync(RETRY_MS);
      await vi.waitFor(async () => {
        await expect(fs.stat(directory)).rejects.toHaveProperty("code", "ENOENT");
        expect(hasBrowserProxyUploadWork()).toBe(false);
      });
    } finally {
      await fs.chmod(child, 0o700).catch(() => {});
      await discardStagedBrowserProxyUpload(staged);
      vi.useRealTimers();
    }
  },
);

it("removes a replaced staging symlink without traversing the linked directory", async () => {
  const uploadDir = tempDirs.make("openclaw-browser-upload-symlink-");
  const staged = await stage(uploadDir);
  await discardStagedBrowserProxyUpload(staged);
  const foreign = path.join(uploadDir, "foreign");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, "keep.txt"), "keep");
  await fs.symlink(foreign, staged.directory!, process.platform === "win32" ? "junction" : "dir");
  await discardStagedBrowserProxyUpload(staged);
  await expect(fs.readFile(path.join(foreign, "keep.txt"), "utf8")).resolves.toBe("keep");
  await expect(fs.lstat(staged.directory!)).rejects.toHaveProperty("code", "ENOENT");
});

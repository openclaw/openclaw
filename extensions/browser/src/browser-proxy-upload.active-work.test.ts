import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BROWSER_PROXY_UPLOAD_ENVELOPE } from "./browser-proxy-envelope.js";

const fixture = vi.hoisted(() => ({ root: "" }));
vi.mock("openclaw/plugin-sdk/temp-path", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/temp-path")>()),
  resolvePreferredOpenClawTmpDir: () => fixture.root,
}));
vi.mock("openclaw/plugin-sdk/text-utility-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/text-utility-runtime")>()),
  get CONFIG_DIR() {
    return fixture.root;
  },
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const HOUR_MS = 60 * 60 * 1000;
const MARKER = ".openclaw-browser-proxy-upload-v1";
const chmodFaultUnavailable = process.platform === "win32" || process.getuid?.() === 0;
let uploads: typeof import("./browser-proxy-upload.js");
const cleanups: Array<() => unknown> = [];
beforeEach(async () => {
  fixture.root = tempDirs.make("openclaw-browser-upload-");
  vi.resetModules();
  uploads = await import("./browser-proxy-upload.js");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(async () => {
  try {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup();
    }
  } finally {
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

async function stage() {
  const staged = await uploads.stageBrowserProxyUploadRequest({
    method: "POST",
    path: "/hooks/file-chooser",
    body: { ref: "e1" },
    upload: {
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [{ name: "report.txt", contentBase64: Buffer.from("report").toString("base64") }],
    },
  });
  cleanups.push(() => uploads.discardStagedBrowserProxyUpload(staged));
  return staged;
}

async function restrictPermissions(target: string, mode: number) {
  await fs.chmod(target, mode);
  cleanups.push(() => fs.chmod(target, 0o700).catch(() => {}));
}

it("keeps filesystem operations busy without treating retained files as active work", async () => {
  expect(uploads.hasBrowserProxyUploadWork()).toBe(false);
  const recovery = uploads.ensureBrowserProxyUploadCleanup();
  expect(uploads.hasBrowserProxyUploadWork()).toBe(true);
  await recovery;
  expect(uploads.hasBrowserProxyUploadWork()).toBe(false);

  const staged = await stage();
  expect(uploads.hasBrowserProxyUploadWork()).toBe(false);
  await expect(fs.readFile(path.join(staged.directory!, "0", "report.txt"), "utf8")).resolves.toBe(
    "report",
  );

  const cleanup = uploads.discardStagedBrowserProxyUpload(staged);
  expect(uploads.hasBrowserProxyUploadWork()).toBe(true);
  await cleanup;
  expect(uploads.hasBrowserProxyUploadWork()).toBe(false);

  const retainedDirectory = (await stage()).directory!;
  await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
  await vi.waitFor(async () => {
    await expect(fs.stat(retainedDirectory)).rejects.toHaveProperty("code", "ENOENT");
    expect(uploads.hasBrowserProxyUploadWork()).toBe(false);
  });
});

it.skipIf(chmodFaultUnavailable)(
  "caches failed recovery and retries repaired storage on the next upload",
  async () => {
    const stagingRoot = path.join(fixture.root, "uploads", ".proxy-uploads");
    const expired = path.join(stagingRoot, "upload-expired");
    await fs.mkdir(expired, { recursive: true });
    await fs.writeFile(path.join(expired, MARKER), "openclaw-browser-proxy-upload-v1\n");
    const past = new Date(Date.now() - 25 * HOUR_MS);
    await fs.utimes(expired, past, past);
    cleanups.push(() => uploads.discardStagedBrowserProxyUpload({ body: {}, directory: expired }));
    await restrictPermissions(stagingRoot, 0o000);
    const reads = vi.spyOn(fs, "readdir");
    cleanups.push(() => reads.mockRestore());
    for (let attempt = 0; attempt < 10; attempt++) {
      await uploads.ensureBrowserProxyUploadCleanup();
    }
    expect(reads.mock.calls.filter(([target]) => target === stagingRoot)).toHaveLength(1);
    expect(uploads.hasBrowserProxyUploadWork()).toBe(false);

    await fs.chmod(stagingRoot, 0o700);
    await stage();
    await expect(fs.stat(expired)).rejects.toHaveProperty("code", "ENOENT");
    expect(uploads.hasBrowserProxyUploadWork()).toBe(false);
  },
);

it.skipIf(chmodFaultUnavailable)(
  "keeps failed deletion recoverable without blocking idle admission",
  async () => {
    const staged = await stage();
    const directory = staged.directory!;
    const child = path.join(directory, "0");
    await restrictPermissions(child, 0o500);
    const cleanup = uploads.discardStagedBrowserProxyUpload(staged);
    expect(uploads.hasBrowserProxyUploadWork()).toBe(true);
    await cleanup;
    await expect(fs.readFile(path.join(directory, MARKER), "utf8")).resolves.toBe(
      "openclaw-browser-proxy-upload-v1\n",
    );
    await expect(fs.readFile(path.join(child, "report.txt"), "utf8")).resolves.toBe("report");
    expect(uploads.hasBrowserProxyUploadWork()).toBe(false);

    await fs.chmod(child, 0o700);
    await uploads.discardStagedBrowserProxyUpload(staged);
    await expect(fs.stat(directory)).rejects.toHaveProperty("code", "ENOENT");
    expect(uploads.hasBrowserProxyUploadWork()).toBe(false);
  },
);

it("removes a replaced staging symlink without traversing the linked directory", async () => {
  const staged = await stage();
  await uploads.discardStagedBrowserProxyUpload(staged);
  const foreign = path.join(fixture.root, "uploads", "foreign");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, "keep.txt"), "keep");
  await fs.symlink(foreign, staged.directory!, process.platform === "win32" ? "junction" : "dir");
  await uploads.discardStagedBrowserProxyUpload(staged);
  await expect(fs.readFile(path.join(foreign, "keep.txt"), "utf8")).resolves.toBe("keep");
  await expect(fs.lstat(staged.directory!)).rejects.toHaveProperty("code", "ENOENT");
});

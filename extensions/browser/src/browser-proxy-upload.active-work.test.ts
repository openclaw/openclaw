import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BROWSER_PROXY_UPLOAD_ENVELOPE as envelope } from "./browser-proxy-envelope.js";

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
const file = { name: "report.txt", contentBase64: Buffer.from("report").toString("base64") };
const chooser = { method: "POST", path: "/hooks/file-chooser", body: { ref: "e1" } };
const upload = { envelope, files: [file] };
const chmodFaultUnavailable = process.platform === "win32" || process.getuid?.() === 0;
let uploads: typeof import("./browser-proxy-upload.js");
const restricted: string[] = [];
beforeEach(async () => {
  fixture.root = tempDirs.make("openclaw-browser-upload-");
  vi.resetModules();
  uploads = await import("./browser-proxy-upload.js");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});
afterEach(async () => {
  for (const directory of restricted.splice(0)) {
    await fs.chmod(directory, 0o700).catch(() => {});
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const stage = () => uploads.stageBrowserProxyUploadRequest({ ...chooser, upload });

async function restrictPermissions(target: string, mode: number) {
  await fs.chmod(target, mode);
  restricted.push(target);
}

const expectIdle = () => expect(uploads.hasBrowserProxyUploadWork()).toBe(false);
const expectMissing = (target: string) =>
  expect(fs.lstat(target)).rejects.toHaveProperty("code", "ENOENT");
const expectContents = (target: string, contents: string) =>
  expect(fs.readFile(target, "utf8")).resolves.toBe(contents);
function expectBusyUntilDone(operation: Promise<void>) {
  expect(uploads.hasBrowserProxyUploadWork()).toBe(true);
  return operation.then(expectIdle);
}

it("keeps filesystem operations busy without treating retained files as active work", async () => {
  expectIdle();
  await expectBusyUntilDone(uploads.ensureBrowserProxyUploadCleanup());
  const staged = await stage();
  expectIdle();
  await expectContents(path.join(staged.directory!, "0", "report.txt"), "report");
  await expectBusyUntilDone(uploads.discardStagedBrowserProxyUpload(staged));
  const retainedDirectory = (await stage()).directory!;
  await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
  await vi.waitFor(async () => {
    await expectMissing(retainedDirectory);
    expectIdle();
  });
});

it.skipIf(chmodFaultUnavailable)("retries cached recovery on the next upload", async () => {
  const stagingRoot = path.join(fixture.root, "uploads", ".proxy-uploads");
  const expired = path.join(stagingRoot, "upload-expired");
  await fs.mkdir(expired, { recursive: true });
  await fs.writeFile(path.join(expired, MARKER), "openclaw-browser-proxy-upload-v1\n");
  const past = new Date(Date.now() - 25 * HOUR_MS);
  await fs.utimes(expired, past, past);
  await restrictPermissions(stagingRoot, 0o000);
  const reads = vi.spyOn(fs, "readdir");
  for (let attempt = 0; attempt < 10; attempt++) {
    await uploads.ensureBrowserProxyUploadCleanup();
  }
  expect(reads.mock.calls.filter(([target]) => target === stagingRoot)).toHaveLength(1);
  expectIdle();
  await fs.chmod(stagingRoot, 0o700);
  await stage();
  await expectMissing(expired);
  expectIdle();
});

it.skipIf(chmodFaultUnavailable)("retains deletion for retry while idle", async () => {
  const staged = await stage();
  const directory = staged.directory!;
  const child = path.join(directory, "0");
  await restrictPermissions(child, 0o500);
  await expectBusyUntilDone(uploads.discardStagedBrowserProxyUpload(staged));
  await expectContents(path.join(directory, MARKER), "openclaw-browser-proxy-upload-v1\n");
  await expectContents(path.join(child, "report.txt"), "report");
  await fs.chmod(child, 0o700);
  await uploads.discardStagedBrowserProxyUpload(staged);
  await expectMissing(directory);
  expectIdle();
});

it("removes a replaced staging symlink without traversing the linked directory", async () => {
  const staged = await stage();
  await uploads.discardStagedBrowserProxyUpload(staged);
  const foreign = path.join(fixture.root, "uploads", "foreign");
  await fs.mkdir(foreign);
  await fs.writeFile(path.join(foreign, "keep.txt"), "keep");
  await fs.symlink(foreign, staged.directory!, process.platform === "win32" ? "junction" : "dir");
  await uploads.discardStagedBrowserProxyUpload(staged);
  await expectContents(path.join(foreign, "keep.txt"), "keep");
  await expectMissing(staged.directory!);
});

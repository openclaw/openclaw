import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROXY_UPLOAD_ENVELOPE,
  type BrowserProxyUploadV1,
} from "./browser-proxy-envelope.js";

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
let uploads: typeof import("./browser-proxy-upload.js");
let browserPaths: typeof import("./browser/paths.js");
let uploadDir: string;
let inboundMediaDir: string;
const chooser = { method: "POST", path: "/hooks/file-chooser", body: {} };
const MARKER_CONTENT = "openclaw-browser-proxy-upload-v1\n";
const markerPath = (directory: string) => path.join(directory, ".openclaw-browser-proxy-upload-v1");
type StageRequest = Parameters<typeof uploads.stageBrowserProxyUploadRequest>[0];
const discard = (staged: Parameters<typeof uploads.discardStagedBrowserProxyUpload>[0]) =>
  uploads.discardStagedBrowserProxyUpload(staged);
const recover = () => uploads.ensureBrowserProxyUploadCleanup();
const expectMissing = (target: string) =>
  expect(fs.lstat(target)).rejects.toHaveProperty("code", "ENOENT");
const expectContents = (target: string, contents: string) =>
  expect(fs.readFile(target, "utf8")).resolves.toBe(contents);

async function initializeUploads(fakeDate = false) {
  const root = (fixture.root = tempDirs.make("browser-proxy-upload-"));
  uploadDir = path.join(root, "uploads");
  inboundMediaDir = path.join(root, "media", "inbound");
  vi.resetModules();
  uploads = await import("./browser-proxy-upload.js");
  if (!fakeDate) {
    browserPaths = await import("./browser/paths.js");
  }
  vi.useFakeTimers({
    toFake: fakeDate ? ["setTimeout", "clearTimeout", "Date"] : ["setTimeout", "clearTimeout"],
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

function stage(options: Partial<StageRequest> = {}) {
  return uploads.stageBrowserProxyUploadRequest({ ...chooser, ...options });
}

function prepare(
  body: unknown,
  options: Partial<Parameters<typeof uploads.prepareBrowserProxyUploadRequest>[0]> = {},
) {
  return uploads.prepareBrowserProxyUploadRequest({ ...chooser, body, ...options });
}

async function expectRoutePaths(paths: string[]) {
  await expect(browserPaths.resolveExistingUploadPaths({ requestedPaths: paths })).resolves.toEqual(
    { ok: true, paths: await Promise.all(paths.map((p) => fs.realpath(p))) },
  );
}

function uploadFiles(...contents: string[]): BrowserProxyUploadV1 {
  return {
    envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
    files: contents.map((text) => ({
      name: "report.txt",
      contentBase64: Buffer.from(text).toString("base64"),
    })),
  };
}

async function addSparsePadding(directory: string, bytes: number) {
  const padding = path.join(directory, "padding.bin");
  await fs.writeFile(padding, "");
  await fs.truncate(padding, bytes);
}

async function retainedDirectory(name: string, contents: string, marked = true) {
  const directory = path.join(uploadDir, ".proxy-uploads", `upload-${name}`);
  await fs.mkdir(directory, { recursive: true });
  if (marked) {
    await fs.writeFile(markerPath(directory), MARKER_CONTENT);
  }
  await fs.writeFile(path.join(directory, "report.txt"), contents, "utf8");
  return directory;
}

describe("browser proxy upload transport", () => {
  beforeEach(() => initializeUploads());
  it("transfers Gateway inbound media bytes instead of resolving the URI on the node", async () => {
    await fs.mkdir(inboundMediaDir, { recursive: true });
    await fs.writeFile(path.join(inboundMediaDir, "report.txt"), "gateway inbound bytes", "utf8");

    const prepared = await prepare({ paths: ["media://inbound/report.txt"] });

    expect(prepared.body).toEqual({});
    expect(prepared.upload?.files).toEqual(uploadFiles("gateway inbound bytes").files);
  });

  it("rejects ambiguous request bodies and invalid encodings before dispatch", async () => {
    const upload: BrowserProxyUploadV1 = {
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [{ name: "report.txt", contentBase64: "not-base64" }],
    };

    await expect(stage({ body: { paths: ["/gateway/report.txt"] }, upload })).rejects.toThrow(
      "browser proxy upload body must omit paths",
    );

    await expect(stage({ upload })).rejects.toThrow("invalid browser proxy upload encoding");
  });

  it("rejects malformed Gateway path arrays instead of forwarding them to the node", async () => {
    await expect(prepare({ paths: [path.join(uploadDir, "report.txt"), 42] })).rejects.toThrow(
      "browser proxy upload paths must contain only strings",
    );
  });

  it("stages distinct files with portable bounded names and route-valid paths", async () => {
    const names = [
      ["report.txt", "report.txt"],
      ["nested/report.txt", "report.txt"],
      ["CONIN$.txt", "CONIN$_.txt"],
      ["NUL .txt", "NUL _.txt"],
      [`CON${" ".repeat(177)}x`, "CON_"],
      [`${"a".repeat(179)}.b`, "a".repeat(179)],
      [`${"c".repeat(175)}🦞.d`, `${"c".repeat(175)}🦞`],
      ["😀".repeat(60), "😀".repeat(45)],
      [`${"a".repeat(176)}.\u00a0.x`, "a".repeat(176)],
      ["path\\nested/ report%!.txt... ", "report__.txt"],
      ["...", "upload"],
    ] as const;
    const staged = await stage({
      upload: {
        envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
        files: names.map(([name]) => ({
          name,
          contentBase64: Buffer.from(name).toString("base64"),
        })),
      },
    });
    const stagedPaths = (staged.body as { paths: string[] }).paths;
    expect(stagedPaths.map((filePath) => path.basename(filePath))).toEqual(
      names.map(([, expected]) => expected),
    );
    for (const [index, filePath] of stagedPaths.entries()) {
      expect(Buffer.byteLength(path.basename(filePath))).toBeLessThanOrEqual(180);
      await expectContents(filePath, names[index]![0]);
    }
    await expectRoutePaths(stagedPaths);
    await discard(staged);
    await expectMissing(staged.directory!);
  });

  it("keeps staging admission serialized after a queued request is cancelled", async () => {
    for (let index = 0; index < 63; index++) {
      await retainedDirectory(`existing-${index}`, "retained");
    }
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const request = { upload: uploadFiles("data") };
    const firstAdmitted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const mkdtemp = fs.mkdtemp;
    vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async (...args) => {
      firstAdmitted.resolve();
      await releaseFirst.promise;
      return await mkdtemp(...args);
    });
    const observeQueue = (signal: AbortSignal) => {
      const queued = Promise.withResolvers<void>();
      const addEventListener = signal.addEventListener.bind(signal);
      vi.spyOn(signal, "addEventListener").mockImplementation((...args) => {
        addEventListener(...args);
        if (args[0] === "abort") {
          queued.resolve();
        }
      });
      return queued.promise;
    };
    const pending = [stage(request)];
    try {
      await firstAdmitted.promise;
      const cancelled = new AbortController();
      const cancelledQueued = observeQueue(cancelled.signal);
      const cancellation = stage({ ...request, signal: cancelled.signal });
      const rejected = expect(cancellation).rejects.toThrow("cancel queued upload");
      await cancelledQueued;
      cancelled.abort(new Error("cancel queued upload"));
      await rejected;

      let thirdAdmissionRead: Promise<unknown> | undefined;
      const readdir = fs.readdir;
      vi.spyOn(fs, "readdir").mockImplementation((...args) => {
        const reading = readdir(...args);
        if (args[0] === stagingRoot) {
          thirdAdmissionRead = reading;
        }
        return reading;
      });
      const third = new AbortController();
      const thirdQueued = observeQueue(third.signal);
      pending.push(stage({ ...request, signal: third.signal }));
      const settled = Promise.allSettled(pending);
      await thirdQueued;
      // Drain ready promise continuations without advancing time or polling the filesystem.
      await new Promise<void>((resolve) => {
        process.nextTick(resolve);
      });
      await thirdAdmissionRead;
      releaseFirst.resolve();
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(results[1]).toMatchObject({
        reason: { message: "RESOURCE_EXHAUSTED: browser proxy upload staging limit reached" },
      });
    } finally {
      releaseFirst.resolve();
      for (const result of await Promise.allSettled(pending)) {
        if (result.status === "fulfilled") {
          await discard(result.value);
        }
      }
    }
  });

  it("counts the ownership marker against retained-byte admission", async () => {
    const retained = await retainedDirectory("retained", "");
    await addSparsePadding(retained, 256 * 1024 * 1024 - Buffer.byteLength(MARKER_CONTENT) - 4);
    await expect(stage({ upload: uploadFiles("data") })).rejects.toThrow(
      "browser proxy upload staging limit reached",
    );
  });

  it.each([true, false])(
    "recovers expired directories only with an ownership marker (%s)",
    async (marked) => {
      const directory = await retainedDirectory("stale", "keep", marked);
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await fs.utimes(directory, staleTime, staleTime);

      await recover();

      if (marked) {
        await expectMissing(directory);
      } else {
        await expectContents(path.join(directory, "report.txt"), "keep");
      }
    },
  );

  it("evicts the oldest retained directory during restart recovery when over quota", async () => {
    const oldestDirectory = await retainedDirectory("oldest", "old");
    const newestDirectory = await retainedDirectory("newest", "new");
    // Recovery counts logical bytes without reading these sparse payloads.
    for (const directory of [oldestDirectory, newestDirectory]) {
      await addSparsePadding(directory, 128 * 1024 * 1024);
    }
    const now = Date.now();
    await fs.utimes(oldestDirectory, new Date(now - 2_000), new Date(now - 2_000));
    await fs.utimes(newestDirectory, new Date(now - 1_000), new Date(now - 1_000));

    await recover();

    await expectMissing(oldestDirectory);
    await expectContents(path.join(newestDirectory, "report.txt"), "new");
  });

  it("leaves unrelated proxy requests unchanged", async () => {
    const body = { paths: ["/tmp/openclaw/uploads/report.txt"] };
    await expect(prepare(body, { path: "/act" })).resolves.toEqual({ body });
    await expect(stage({ body, path: "/act" })).resolves.toEqual({ body });
  });
});

describe("browser proxy upload activity", () => {
  const HOUR_MS = 60 * 60 * 1000;
  const chmodFaultUnavailable = process.platform === "win32" || process.getuid?.() === 0;
  const restricted: string[] = [];
  const stageReport = () => stage({ body: { ref: "e1" }, upload: uploadFiles("report") });
  beforeEach(() => initializeUploads(true));
  afterEach(async () => {
    for (const directory of restricted.splice(0)) {
      await fs.chmod(directory, 0o700).catch(() => {});
    }
  });
  async function restrictPermissions(target: string, mode: number) {
    await fs.chmod(target, mode);
    restricted.push(target);
  }

  const expectIdle = () => expect(uploads.hasBrowserProxyUploadWork()).toBe(false);
  function expectBusyUntilDone(operation: Promise<void>) {
    expect(uploads.hasBrowserProxyUploadWork()).toBe(true);
    return operation.then(expectIdle);
  }

  it("keeps filesystem operations busy without treating retained files as active work", async () => {
    expectIdle();
    await expectBusyUntilDone(recover());
    const staged = await stageReport();
    expectIdle();
    await expectContents(path.join(staged.directory!, "0", "report.txt"), "report");
    await expectBusyUntilDone(discard(staged));
    const retained = (await stageReport()).directory!;
    await vi.advanceTimersByTimeAsync(24 * HOUR_MS);
    await vi.waitFor(async () => {
      await expectMissing(retained);
      expectIdle();
    });
  });

  it.skipIf(chmodFaultUnavailable)("retries cached recovery on the next upload", async () => {
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const expired = await retainedDirectory("expired", "");
    const past = new Date(Date.now() - 25 * HOUR_MS);
    await fs.utimes(expired, past, past);
    await restrictPermissions(stagingRoot, 0o000);
    const reads = vi.spyOn(fs, "readdir");
    for (let attempt = 0; attempt < 10; attempt++) {
      await recover();
    }
    expect(reads.mock.calls.filter(([target]) => target === stagingRoot)).toHaveLength(1);
    expectIdle();
    await fs.chmod(stagingRoot, 0o700);
    await stageReport();
    await expectMissing(expired);
    expectIdle();
  });

  it.skipIf(chmodFaultUnavailable)("retains deletion for retry while idle", async () => {
    const staged = await stageReport();
    const directory = staged.directory!;
    const child = path.join(directory, "0");
    await restrictPermissions(child, 0o500);
    await expectBusyUntilDone(discard(staged));
    await expectContents(markerPath(directory), MARKER_CONTENT);
    await expectContents(path.join(child, "report.txt"), "report");
    await fs.chmod(child, 0o700);
    await discard(staged);
    await expectMissing(directory);
    expectIdle();
  });

  it("removes a replaced staging symlink without traversing the linked directory", async () => {
    const staged = await stageReport();
    await discard(staged);
    const foreign = path.join(fixture.root, "uploads", "foreign");
    await fs.mkdir(foreign);
    await fs.writeFile(path.join(foreign, "keep.txt"), "keep");
    await fs.symlink(foreign, staged.directory!, process.platform === "win32" ? "junction" : "dir");
    await discard(staged);
    await expectContents(path.join(foreign, "keep.txt"), "keep");
    await expectMissing(staged.directory!);
  });
});

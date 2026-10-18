import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BROWSER_PROXY_UPLOAD_ENVELOPE,
  type BrowserProxyUploadV1,
} from "./browser-proxy-envelope.js";
import {
  discardStagedBrowserProxyUpload,
  ensureBrowserProxyUploadCleanup,
  prepareBrowserProxyUploadRequest,
  stageBrowserProxyUploadRequest,
} from "./browser-proxy-upload.js";
import { resolveExistingUploadPaths } from "./browser/paths.js";

let root: string;
let uploadDir: string;
let inboundMediaDir: string;
const chooser = { method: "POST", path: "/hooks/file-chooser", body: {} };
type StageRequest = Parameters<typeof stageBrowserProxyUploadRequest>[0];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-proxy-upload-"));
  uploadDir = path.join(root, "uploads");
  inboundMediaDir = path.join(root, "inbound");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

function stage(options: Partial<StageRequest> = {}) {
  return stageBrowserProxyUploadRequest({ ...chooser, uploadDir, ...options });
}

function prepare(
  body: unknown,
  options: Partial<Parameters<typeof prepareBrowserProxyUploadRequest>[0]> = {},
) {
  return prepareBrowserProxyUploadRequest({
    ...chooser,
    uploadDir,
    inboundMediaDir,
    body,
    ...options,
  });
}

async function expectRoutePaths(paths: string[]) {
  await expect(
    resolveExistingUploadPaths({ requestedPaths: paths, uploadDir, inboundMediaDir }),
  ).resolves.toEqual({ ok: true, paths: await Promise.all(paths.map((p) => fs.realpath(p))) });
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

async function retainedDirectory(name: string, contents: string, marked = true) {
  const directory = path.join(uploadDir, ".proxy-uploads", `upload-${name}`);
  await fs.mkdir(directory, { recursive: true });
  if (marked) {
    await fs.writeFile(
      path.join(directory, ".openclaw-browser-proxy-upload-v1"),
      "openclaw-browser-proxy-upload-v1\n",
      "utf8",
    );
  }
  await fs.writeFile(path.join(directory, "report.txt"), contents, "utf8");
  return directory;
}

async function addSparsePadding(directory: string, bytes: number) {
  const padding = path.join(directory, "padding.bin");
  await fs.writeFile(padding, "");
  await fs.truncate(padding, bytes);
}

describe("browser proxy upload transport", () => {
  it("transfers Gateway inbound media bytes instead of resolving the URI on the node", async () => {
    await fs.mkdir(inboundMediaDir, { recursive: true });
    await fs.writeFile(path.join(inboundMediaDir, "report.txt"), "gateway inbound bytes", "utf8");

    const prepared = await prepare({ paths: ["media://inbound/report.txt"] });

    expect(prepared.body).toEqual({});
    expect(prepared.upload?.files).toEqual([
      {
        name: "report.txt",
        contentBase64: Buffer.from("gateway inbound bytes").toString("base64"),
      },
    ]);
  });

  it("stages files under the node upload root with route-valid paths", async () => {
    const staged = await stage({
      body: { ref: "e12" },
      upload: uploadFiles("node copy", "second copy"),
    });
    const stagedPaths = (staged.body as { paths: string[] }).paths;
    expect(stagedPaths).toHaveLength(2);
    expect(stagedPaths.map((filePath) => path.basename(filePath))).toEqual([
      "report.txt",
      "report.txt",
    ]);
    await expect(fs.readFile(stagedPaths[0] ?? "", "utf8")).resolves.toBe("node copy");
    await expect(fs.readFile(stagedPaths[1] ?? "", "utf8")).resolves.toBe("second copy");
    await expectRoutePaths(stagedPaths);

    await discardStagedBrowserProxyUpload(staged);
    await expect(fs.stat(staged.directory ?? "")).rejects.toHaveProperty("code", "ENOENT");
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
    await fs.mkdir(uploadDir, { recursive: true });
    const sourcePath = path.join(uploadDir, "report.txt");
    await fs.writeFile(sourcePath, "gateway bytes", "utf8");

    await expect(prepare({ paths: [sourcePath, 42] })).rejects.toThrow(
      "browser proxy upload paths must contain only strings",
    );
  });

  it("stages portable bounded filenames that survive upload route validation", async () => {
    const names = [
      ["CLOCK$", "CLOCK$_"],
      ["CONIN$.txt", "CONIN$_.txt"],
      ["CONOUT$", "CONOUT$_"],
      ["NUL .txt", "NUL _.txt"],
      ["COM¹.txt", "COM¹_.txt"],
      [`CON${" ".repeat(177)}x`, "CON_"],
      [`${"a".repeat(179)}.b`, "a".repeat(179)],
      [`${"b".repeat(179)} c`, "b".repeat(179)],
      [`${"c".repeat(175)}🦞.d`, `${"c".repeat(175)}🦞`],
      ["😀".repeat(60), "😀".repeat(45)],
      [`${"a".repeat(176)}.\u00a0.x`, "a".repeat(176)],
      ["path\\nested/ report%!.txt... ", "report__.txt"],
      ["...", "upload"],
    ] as const;
    const staged = await stage({
      upload: {
        envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
        files: names.map(([name]) => ({ name, contentBase64: "aGVsbG8=" })),
      },
    });
    try {
      const stagedPaths = (staged.body as { paths: string[] }).paths;
      expect(stagedPaths.map((filePath) => path.basename(filePath))).toEqual(
        names.map(([, expected]) => expected),
      );
      for (const filePath of stagedPaths) {
        expect(Buffer.byteLength(path.basename(filePath))).toBeLessThanOrEqual(180);
        await expect(fs.readFile(filePath, "utf8")).resolves.toBe("hello");
      }
      await expectRoutePaths(stagedPaths);
    } finally {
      await discardStagedBrowserProxyUpload(staged);
    }
  });

  it("keeps staging admission serialized after a queued request is cancelled", async () => {
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const retainedDirectories: string[] = [];
    for (let index = 0; index < 63; index += 1) {
      retainedDirectories.push(await retainedDirectory(`retained-${index}`, ""));
    }
    const request: Partial<StageRequest> = {
      upload: uploadFiles("data"),
    };
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

      let thirdAdmissionStarted = false;
      const thirdAdmissionRead = Promise.withResolvers<void>();
      const readdir = fs.readdir;
      vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
        if (args[0] === stagingRoot) {
          thirdAdmissionStarted = true;
        }
        const entries = await readdir(...args);
        if (args[0] === stagingRoot) {
          thirdAdmissionRead.resolve();
        }
        return entries;
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
      if (thirdAdmissionStarted) {
        await thirdAdmissionRead.promise;
      }
      releaseFirst.resolve();
      const results = await settled;
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(results[1]).toMatchObject({
        reason: expect.objectContaining({
          message: "RESOURCE_EXHAUSTED: browser proxy upload staging limit reached",
        }),
      });
    } finally {
      releaseFirst.resolve();
      for (const result of await Promise.allSettled(pending)) {
        if (result.status === "fulfilled") {
          await discardStagedBrowserProxyUpload(result.value);
        }
      }
      for (const directory of retainedDirectories) {
        await discardStagedBrowserProxyUpload({ body: {}, directory });
      }
    }
  });

  it("counts the ownership marker against retained-byte admission", async () => {
    const directory = await retainedDirectory("almost-full", "");
    await addSparsePadding(
      directory,
      256 * 1024 * 1024 - 4 - Buffer.byteLength("openclaw-browser-proxy-upload-v1\n"),
    );
    try {
      await expect(stage({ upload: uploadFiles("data") })).rejects.toThrow(
        "browser proxy upload staging limit reached",
      );
    } finally {
      await discardStagedBrowserProxyUpload({ body: {}, directory });
    }
  });

  it.each([true, false])(
    "recovers expired directories only with an ownership marker (%s)",
    async (marked) => {
      const directory = await retainedDirectory("stale", "keep", marked);
      const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
      await fs.utimes(directory, staleTime, staleTime);

      await ensureBrowserProxyUploadCleanup({ uploadDir });

      if (marked) {
        await expect(fs.stat(directory)).rejects.toHaveProperty("code", "ENOENT");
      } else {
        await expect(fs.readFile(path.join(directory, "report.txt"), "utf8")).resolves.toBe("keep");
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

    await ensureBrowserProxyUploadCleanup({ uploadDir });

    await expect(fs.stat(oldestDirectory)).rejects.toHaveProperty("code", "ENOENT");
    await expect(fs.readFile(path.join(newestDirectory, "report.txt"), "utf8")).resolves.toBe(
      "new",
    );
  });

  it("leaves unrelated proxy requests unchanged", async () => {
    const body = { paths: ["/tmp/openclaw/uploads/report.txt"] };
    await expect(prepare(body, { path: "/act" })).resolves.toEqual({ body });
    await expect(stage({ body, path: "/act" })).resolves.toEqual({ body });
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const tempRoots: string[] = [];

async function createTempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), label));
  tempRoots.push(root);
  return root;
}

function chooser(body: unknown = {}) {
  return { method: "POST", path: "/hooks/file-chooser", body };
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

async function retainedDirectory(uploadDir: string, name: string, contents: string, marked = true) {
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

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("browser proxy upload transport", () => {
  it("transfers Gateway inbound media bytes instead of resolving the URI on the node", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-inbound-");
    const uploadDir = path.join(root, "uploads");
    const inboundMediaDir = path.join(root, "media", "inbound");
    await fs.mkdir(inboundMediaDir, { recursive: true });
    await fs.writeFile(path.join(inboundMediaDir, "report.txt"), "gateway inbound bytes", "utf8");

    const prepared = await prepareBrowserProxyUploadRequest({
      ...chooser({ paths: ["media://inbound/report.txt"] }),
      uploadDir,
      inboundMediaDir,
    });

    expect(prepared.body).toEqual({});
    expect(prepared.upload?.files).toEqual([
      {
        name: "report.txt",
        contentBase64: Buffer.from("gateway inbound bytes").toString("base64"),
      },
    ]);
  });

  it("stages files under the node upload root with route-valid paths", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-node-");
    const uploadDir = path.join(root, "uploads");
    const staged = await stageBrowserProxyUploadRequest({
      ...chooser({ ref: "e12" }),
      upload: uploadFiles("node copy", "second copy"),
      uploadDir,
    });
    const stagedPaths = (staged.body as { paths: string[] }).paths;
    const canonicalStagedPaths = await Promise.all(
      stagedPaths.map((filePath) => fs.realpath(filePath)),
    );

    expect(stagedPaths).toHaveLength(2);
    expect(stagedPaths.map((filePath) => path.basename(filePath))).toEqual([
      "report.txt",
      "report.txt",
    ]);
    await expect(fs.readFile(stagedPaths[0] ?? "", "utf8")).resolves.toBe("node copy");
    await expect(fs.readFile(stagedPaths[1] ?? "", "utf8")).resolves.toBe("second copy");
    await expect(
      resolveExistingUploadPaths({
        requestedPaths: stagedPaths,
        uploadDir,
        inboundMediaDir: path.join(root, "inbound"),
      }),
    ).resolves.toEqual({ ok: true, paths: canonicalStagedPaths });

    await discardStagedBrowserProxyUpload(staged);
    await expect(fs.stat(staged.directory ?? "")).rejects.toHaveProperty("code", "ENOENT");
  });

  it("rejects ambiguous request bodies and invalid encodings before dispatch", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-invalid-");
    const upload: BrowserProxyUploadV1 = {
      envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
      files: [{ name: "report.txt", contentBase64: "not-base64" }],
    };

    await expect(
      stageBrowserProxyUploadRequest({
        ...chooser({ paths: ["/gateway/report.txt"] }),
        upload,
        uploadDir: path.join(root, "uploads"),
      }),
    ).rejects.toThrow("browser proxy upload body must omit paths");

    await expect(
      stageBrowserProxyUploadRequest({
        ...chooser(),
        upload,
        uploadDir: path.join(root, "uploads"),
      }),
    ).rejects.toThrow("invalid browser proxy upload encoding");
  });

  it("rejects malformed Gateway path arrays instead of forwarding them to the node", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-malformed-");
    const uploadDir = path.join(root, "uploads");
    await fs.mkdir(uploadDir, { recursive: true });
    const sourcePath = path.join(uploadDir, "report.txt");
    await fs.writeFile(sourcePath, "gateway bytes", "utf8");

    await expect(
      prepareBrowserProxyUploadRequest({
        ...chooser({ paths: [sourcePath, 42] }),
        uploadDir,
        inboundMediaDir: path.join(root, "inbound"),
      }),
    ).rejects.toThrow("browser proxy upload paths must contain only strings");
  });

  it("stages portable bounded filenames that survive upload route validation", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-portable-");
    const uploadDir = path.join(root, "uploads");
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
    const staged = await stageBrowserProxyUploadRequest({
      ...chooser(),
      upload: {
        envelope: BROWSER_PROXY_UPLOAD_ENVELOPE,
        files: names.map(([name]) => ({ name, contentBase64: "aGVsbG8=" })),
      },
      uploadDir,
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
      await expect(
        resolveExistingUploadPaths({
          requestedPaths: stagedPaths,
          uploadDir,
          inboundMediaDir: path.join(root, "inbound"),
        }),
      ).resolves.toEqual({
        ok: true,
        paths: await Promise.all(stagedPaths.map((p) => fs.realpath(p))),
      });
    } finally {
      await discardStagedBrowserProxyUpload(staged);
    }
  });

  it("keeps staging admission serialized after a queued request is cancelled", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-cancelled-queue-");
    const uploadDir = path.join(root, "uploads");
    const stagingRoot = path.join(uploadDir, ".proxy-uploads");
    const request: Parameters<typeof stageBrowserProxyUploadRequest>[0] = {
      ...chooser(),
      uploadDir,
      maxRetainedDirectories: 1,
      upload: uploadFiles("data"),
    };
    const firstAdmitted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const mkdtemp = fs.mkdtemp;
    const allocation = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async (...args) => {
      firstAdmitted.resolve();
      await releaseFirst.promise;
      return await mkdtemp(...args);
    });
    const queueObservers: Array<{ mockRestore(): void }> = [];
    const observeQueue = (signal: AbortSignal) => {
      const queued = Promise.withResolvers<void>();
      const addEventListener = signal.addEventListener.bind(signal);
      queueObservers.push(
        vi.spyOn(signal, "addEventListener").mockImplementation((...args) => {
          addEventListener(...args);
          if (args[0] === "abort") {
            queued.resolve();
          }
        }),
      );
      return queued.promise;
    };
    const pending = [stageBrowserProxyUploadRequest(request)];
    let admissionRead: { mockRestore(): void } | undefined;
    try {
      await firstAdmitted.promise;
      const cancelled = new AbortController();
      const cancelledQueued = observeQueue(cancelled.signal);
      const cancellation = stageBrowserProxyUploadRequest({ ...request, signal: cancelled.signal });
      const rejected = expect(cancellation).rejects.toThrow("cancel queued upload");
      await cancelledQueued;
      cancelled.abort(new Error("cancel queued upload"));
      await rejected;

      let thirdAdmissionStarted = false;
      const thirdAdmissionRead = Promise.withResolvers<void>();
      const readdir = fs.readdir;
      admissionRead = vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
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
      pending.push(stageBrowserProxyUploadRequest({ ...request, signal: third.signal }));
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
      admissionRead?.mockRestore();
      allocation.mockRestore();
      for (const observer of queueObservers) {
        observer.mockRestore();
      }
    }
  });

  it("counts the ownership marker against retained-byte admission", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-marker-limit-");
    await expect(
      stageBrowserProxyUploadRequest({
        ...chooser(),
        upload: uploadFiles("data"),
        uploadDir: path.join(root, "uploads"),
        maxRetainedBytes: 4,
        maxRetainedDirectories: 10,
      }),
    ).rejects.toThrow("browser proxy upload staging limit reached");
  });

  it("removes expired staged directories during startup recovery", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-recovery-");
    const uploadDir = path.join(root, "uploads");
    const staleDirectory = await retainedDirectory(uploadDir, "stale", "stale");
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(staleDirectory, staleTime, staleTime);

    await ensureBrowserProxyUploadCleanup({
      uploadDir,
      retentionMs: 1,
      nowMs: Date.now(),
    });

    await expect(fs.stat(staleDirectory)).rejects.toHaveProperty("code", "ENOENT");
  });

  it("evicts the oldest retained directory during restart recovery when over quota", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-recovery-quota-");
    const uploadDir = path.join(root, "uploads");
    const oldestDirectory = await retainedDirectory(uploadDir, "oldest", "old");
    const newestDirectory = await retainedDirectory(uploadDir, "newest", "new");
    const now = Date.now();
    await fs.utimes(oldestDirectory, new Date(now - 2_000), new Date(now - 2_000));
    await fs.utimes(newestDirectory, new Date(now - 1_000), new Date(now - 1_000));

    await ensureBrowserProxyUploadCleanup({
      uploadDir,
      nowMs: now,
      maxRetainedBytes: 50,
      maxRetainedDirectories: 10,
    });

    await expect(fs.stat(oldestDirectory)).rejects.toHaveProperty("code", "ENOENT");
    await expect(fs.readFile(path.join(newestDirectory, "report.txt"), "utf8")).resolves.toBe(
      "new",
    );
  });

  it("does not recover unmarked directories from the private staging root", async () => {
    const root = await createTempRoot("openclaw-browser-proxy-recovery-unmarked-");
    const uploadDir = path.join(root, "uploads");
    const unrelatedDirectory = await retainedDirectory(uploadDir, "archive", "keep", false);
    const staleTime = new Date(Date.now() - 10_000);
    await fs.utimes(unrelatedDirectory, staleTime, staleTime);

    await ensureBrowserProxyUploadCleanup({
      uploadDir,
      retentionMs: 1,
      nowMs: Date.now(),
    });

    await expect(fs.readFile(path.join(unrelatedDirectory, "report.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("leaves unrelated proxy requests unchanged", async () => {
    const body = { paths: ["/tmp/openclaw/uploads/report.txt"] };
    await expect(
      prepareBrowserProxyUploadRequest({
        method: "POST",
        path: "/act",
        body,
      }),
    ).resolves.toEqual({ body });
    await expect(
      stageBrowserProxyUploadRequest({
        method: "POST",
        path: "/act",
        body,
      }),
    ).resolves.toEqual({ body });
  });
});

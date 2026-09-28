// Diffs tests cover store plugin behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { PluginBlobStore, PluginBlobEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDiffsHttpHandler } from "./http.js";
import { DiffArtifactStore } from "./store.js";
import {
  createDiffStoreHarness,
  ensureCuratedViewerRuntimeForTests,
  expireDiffArtifactForTest,
} from "./test-helpers.js";
import type { DiffArtifactBlobMetadata } from "./types.js";

type CompressionCallback = (error: Error | null, bytes: Buffer) => void;
const compression = vi.hoisted(() => ({
  gzip: vi.fn<(input: Uint8Array, callback: CompressionCallback) => void>(),
  gunzip:
    vi.fn<
      (
        input: Uint8Array,
        options: { maxOutputLength: number },
        callback: CompressionCallback,
      ) => void
    >(),
}));

// Keep stable functions before store import: promisify captures them once.
// Outside an individual callback fixture these forward to native compression.
vi.mock("node:zlib", async (importOriginal) => {
  const native = await importOriginal<typeof import("node:zlib")>();
  return {
    ...native,
    gzip: compression.gzip.mockImplementation(native.gzip),
    gunzip: compression.gunzip.mockImplementation(native.gunzip),
  };
});

beforeAll(async () => {
  await ensureCuratedViewerRuntimeForTests();
});

describe("DiffArtifactStore", () => {
  let rootDir: string;
  let store: DiffArtifactStore;
  let blobStore: PluginBlobStore<DiffArtifactBlobMetadata>;
  let reopenStore: Awaited<ReturnType<typeof createDiffStoreHarness>>["reopen"];
  let cleanupRootDir: () => Promise<void>;

  beforeEach(async () => {
    ({
      rootDir,
      store,
      blobStore,
      reopen: reopenStore,
      cleanup: cleanupRootDir,
    } = await createDiffStoreHarness("openclaw-diffs-store-", { nativeKernel: true }));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupRootDir();
  });

  describe("compression contract", () => {
    const maximum = 64 * 1024 * 1024;
    const params = { title: "Compression", inputKind: "patch", fileCount: 1 } as const;

    beforeEach(async () => {
      const native = await vi.importActual<typeof import("node:zlib")>("node:zlib");
      compression.gzip.mockReset().mockImplementation(native.gzip);
      compression.gunzip.mockReset().mockImplementation(native.gunzip);
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(["empty", "multibyte", "limit"] as const)(
      "round trips native compressed %s bytes through SQLite",
      async (kind) => {
        const html = kind === "limit" ? "x".repeat(maximum) : kind === "empty" ? "" : "é 🦀\0";
        const expected = Buffer.from(html);
        const artifact = await store.createArtifact({ ...params, html });
        const entry = await blobStore.lookup(artifact.id);
        assert.isDefined(entry);
        expect(entry.metadata).toMatchObject({ decodedBytes: Buffer.byteLength(html) });
        expect(Buffer.compare(gunzipSync(entry.bytes), expected)).toBe(0);
        const loaded = await store.readAuthorizedViewer(artifact.id, artifact.token);
        assert.isNotNull(loaded);
        expect(Buffer.compare(loaded.html, expected)).toBe(0);
        expect(compression.gunzip).toHaveBeenCalledExactlyOnceWith(
          entry.bytes,
          { maxOutputLength: maximum },
          expect.any(Function),
        );
      },
    );

    it("rejects oversized input before compression, token creation, registration or cleanup", async () => {
      const random = vi.spyOn(crypto, "randomBytes");
      const register = vi.spyOn(blobStore, "registerIfAbsent");
      const cleanup = vi.spyOn(store, "scheduleCleanup");
      await expect(
        store.createArtifact({ ...params, html: "x".repeat(maximum + 1) }),
      ).rejects.toThrow(`Diff viewer HTML exceeds ${maximum} bytes.`);
      expect(compression.gzip).not.toHaveBeenCalled();
      expect(random).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
    });

    it.each(["corrupt", "size-mismatch", "oversized-output"] as const)(
      "rejects %s with valid authorized metadata",
      async (kind) => {
        const artifact = await store.createArtifact({ ...params, html: "viewer" });
        const entry = await blobStore.lookup(artifact.id);
        assert.isDefined(entry);
        if (entry.metadata.kind !== "viewer") {
          throw new Error("Expected viewer metadata");
        }
        const bytes =
          kind === "corrupt"
            ? Buffer.from("invalid gzip")
            : kind === "oversized-output"
              ? gzipSync(Buffer.alloc(maximum + 1, 120))
              : entry.bytes;
        const decodedBytes =
          kind === "oversized-output" ? maximum : Buffer.byteLength("viewer") + 1;
        await blobStore.register(artifact.id, bytes, { ...entry.metadata, decodedBytes });
        await expect(
          store.readAuthorizedViewer(artifact.id, artifact.token),
        ).rejects.toBeInstanceOf(Error);
        expect(compression.gunzip).toHaveBeenCalledExactlyOnceWith(
          expect.any(Uint8Array),
          { maxOutputLength: maximum },
          expect.any(Function),
        );
        const call = compression.gunzip.mock.calls[0];
        assert.isDefined(call);
        expect(Buffer.compare(call[0], bytes)).toBe(0);
      },
    );

    it("awaits compression before side effects and retains callback buffer identities", async () => {
      const html = Buffer.from("callback result");
      const compressed = gzipSync(html);
      const started = Promise.withResolvers<CompressionCallback>();
      compression.gzip.mockImplementationOnce((input, callback) => {
        expect(input).toEqual(html);
        started.resolve(callback);
      });
      const random = vi.spyOn(crypto, "randomBytes");
      const register = vi.spyOn(blobStore, "registerIfAbsent");
      const cleanup = vi.spyOn(store, "scheduleCleanup");
      const pending = store.createArtifact({ ...params, html: html.toString() });
      const complete = await started.promise;
      expect(random).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
      complete(null, compressed);
      const artifact = await pending;
      expect(register.mock.calls[0]?.[1]).toBe(compressed);
      expect(register.mock.invocationCallOrder[0]).toBeLessThan(
        cleanup.mock.invocationCallOrder[0]!,
      );
      const entry = await blobStore.lookup(artifact.id);
      assert.isDefined(entry);
      expect(Buffer.compare(entry.bytes, compressed)).toBe(0);
      compression.gunzip.mockImplementationOnce((input, options, callback) => {
        expect(Buffer.compare(input, compressed)).toBe(0);
        expect(options).toEqual({ maxOutputLength: maximum });
        callback(null, html);
      });
      expect((await store.readAuthorizedViewer(artifact.id, artifact.token))?.html).toBe(html);
    });

    it.each([
      ["gzip", "callback"],
      ["gzip", "throw"],
      ["gunzip", "callback"],
      ["gunzip", "throw"],
    ] as const)("preserves %s %s error identity", async (operation, mode) => {
      const artifact = await store.createArtifact({ ...params, html: "failure fixture" });
      const failure = new Error(`${operation} fixture`);
      const complete = (callback: CompressionCallback) => {
        if (mode === "throw") {
          throw failure;
        }
        callback(failure, Buffer.alloc(0));
      };
      if (operation === "gzip") {
        compression.gzip.mockImplementationOnce((_input, callback) => complete(callback));
      } else {
        compression.gunzip.mockImplementationOnce((_input, _options, callback) =>
          complete(callback),
        );
      }
      const random = vi.spyOn(crypto, "randomBytes");
      const register = vi.spyOn(blobStore, "registerIfAbsent");
      const cleanup = vi.spyOn(store, "scheduleCleanup");
      const pending =
        operation === "gzip"
          ? store.createArtifact({ ...params, html: "failure fixture" })
          : store.readAuthorizedViewer(artifact.id, artifact.token);
      await expect(pending).rejects.toBe(failure);
      expect(random).not.toHaveBeenCalled();
      expect(register).not.toHaveBeenCalled();
      expect(cleanup).not.toHaveBeenCalled();
    });
  });

  async function mockDateBoundaryBlob() {
    await store.stopCleanup();
    vi.useFakeTimers({ toFake: ["Date"] });
    const maximum = 8_640_000_000_000_000;
    vi.setSystemTime(maximum - 1_000);
    let entry: PluginBlobEntry<DiffArtifactBlobMetadata> | undefined;
    const register = vi
      .spyOn(blobStore, "registerIfAbsent")
      .mockImplementation(async (key, bytes, metadata) => {
        entry = {
          key,
          bytes,
          metadata,
          sizeBytes: bytes.byteLength,
          createdAt: maximum - 1_000,
          expiresAt: maximum,
        };
        return true;
      });
    const lookup = vi.spyOn(blobStore, "lookup").mockImplementation(async () => entry);
    return {
      register,
      restore() {
        lookup.mockRestore();
        register.mockRestore();
      },
    };
  }

  it("stores compressed viewer bytes and retrieves them with one authorized lookup", async () => {
    const lookup = vi.spyOn(blobStore, "lookup");
    const artifact = await store.createArtifact({
      html: "<html>demo é 🦀</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
      context: {
        agentId: "main",
        sessionId: "session-123",
        messageChannel: "discord",
        agentAccountId: "default",
      },
    });
    const stored = await blobStore.lookup(artifact.id);
    expect(stored?.metadata).toMatchObject({
      version: 1,
      kind: "viewer",
      encoding: "gzip",
      decodedBytes: Buffer.byteLength("<html>demo é 🦀</html>"),
    });
    expect(JSON.stringify(stored?.metadata)).not.toContain(artifact.token);
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });

    lookup.mockClear();
    const loaded = await store.readAuthorizedViewer(artifact.id, artifact.token);
    expect(loaded?.artifact.id).toBe(artifact.id);
    expect(loaded?.artifact.context).toEqual({
      agentId: "main",
      sessionId: "session-123",
      messageChannel: "discord",
      agentAccountId: "default",
    });
    expect(Buffer.from(loaded!.html).toString("utf8")).toBe("<html>demo é 🦀</html>");
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(store.readAuthorizedViewer(artifact.id, "0".repeat(48))).resolves.toBeNull();
    await expect(store.readAuthorizedViewer(artifact.id, "short")).resolves.toBeNull();
  });

  it("caps artifact expiry instead of throwing near the Date boundary", async () => {
    const boundary = await mockDateBoundaryBlob();
    try {
      const artifact = await store.createArtifact({
        html: "<html>demo</html>",
        title: "Demo",
        inputKind: "patch",
        fileCount: 1,
        ttlMs: 60_000,
      });

      expect(artifact.expiresAt).toBe("+275760-09-13T00:00:00.000Z");
      expect(boundary.register).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Uint8Array),
        expect.any(Object),
        { ttlMs: 1_000 },
      );
    } finally {
      boundary.restore();
    }
  });

  it("serves viewer artifacts after reopening the shared SQLite store", async () => {
    const artifact = await store.createArtifact({
      html: "<html>persisted</html>",
      title: "Persisted",
      inputKind: "patch",
      fileCount: 1,
    });
    ({ store, blobStore } = await reopenStore());

    const loaded = await store.readAuthorizedViewer(artifact.id, artifact.token);
    expect(Buffer.from(loaded!.html).toString("utf8")).toBe("<html>persisted</html>");
  });

  it("expires artifacts after the ttl", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const artifact = await store.createArtifact({
      html: "<html>demo</html>",
      title: "Demo",
      inputKind: "patch",
      fileCount: 2,
      ttlMs: 1_000,
    });

    await store.stopCleanup();
    await expireDiffArtifactForTest(rootDir, artifact.id, 1_000);
    const loaded = await store.readAuthorizedViewer(artifact.id, artifact.token);
    expect(loaded).toBeNull();
    await expect(blobStore.deleteExpired()).resolves.toEqual([]);
  });

  it("creates standalone file artifacts with SQLite metadata and derived temp paths", async () => {
    const standalone = await store.createStandaloneFileArtifact({
      context: {
        agentId: "main",
        sessionId: "session-123",
      },
    });
    expect(standalone.filePath).toMatch(/preview\.png$/);
    expect(standalone.filePath).toContain(rootDir);
    expect(Date.parse(standalone.expiresAt)).toBeGreaterThan(Date.now());
    expect(standalone.context).toEqual({
      agentId: "main",
      sessionId: "session-123",
    });
    await expect(blobStore.lookup(standalone.id)).resolves.toMatchObject({
      key: standalone.id,
      sizeBytes: 0,
      metadata: { version: 1, kind: "rendered_file", format: "png" },
    });
    await store.completeFileArtifact(standalone.id);
  });

  it("caps standalone file expiry instead of throwing near the Date boundary", async () => {
    const boundary = await mockDateBoundaryBlob();
    try {
      const standalone = await store.createStandaloneFileArtifact({ ttlMs: 60_000 });

      expect(standalone.expiresAt).toBe("+275760-09-13T00:00:00.000Z");
      expect(boundary.register).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Uint8Array),
        expect.any(Object),
        { ttlMs: 1_000 },
      );
    } finally {
      boundary.restore();
    }
  });

  it("expires standalone file artifacts using ttl metadata", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const standalone = await store.createStandaloneFileArtifact({
      format: "png",
      ttlMs: 1_000,
    });
    await fs.writeFile(standalone.filePath, Buffer.from("png"));
    await store.completeFileArtifact(standalone.id);

    await store.stopCleanup();
    await expireDiffArtifactForTest(rootDir, standalone.id, 1_000);
    await store.cleanupExpired();

    const error = await fs.stat(path.dirname(standalone.filePath)).then(
      () => undefined,
      (statError: unknown) => statError,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  it("allocates PDF file paths when format is pdf", async () => {
    const standalonePdf = await store.createStandaloneFileArtifact({ format: "pdf" });
    expect(standalonePdf.filePath).toMatch(/preview\.pdf$/);
    await store.completeFileArtifact(standalonePdf.id);
  });

  it("drops an artifact row and temp directory after render failure", async () => {
    const standalone = await store.createStandaloneFileArtifact();
    await fs.writeFile(standalone.filePath, "partial");

    await store.deleteFileArtifact(standalone.id);

    await expect(blobStore.lookup(standalone.id)).resolves.toBeUndefined();
    await expect(fs.stat(path.dirname(standalone.filePath))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes only expired file rows and leaves live materializations", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const expired = await store.createStandaloneFileArtifact({ ttlMs: 1_000 });
    const live = await store.createStandaloneFileArtifact({ ttlMs: 60_000 });
    await fs.writeFile(expired.filePath, "expired");
    await fs.writeFile(live.filePath, "live");
    await store.completeFileArtifact(expired.id);
    await store.completeFileArtifact(live.id);

    await store.stopCleanup();
    vi.setSystemTime(Date.parse(expired.expiresAt) + 1);
    await expect(blobStore.lookup(expired.id)).resolves.toBeUndefined();
    await expireDiffArtifactForTest(rootDir, expired.id, 1_000);
    await store.cleanupExpired();

    await expect(fs.stat(path.dirname(expired.filePath))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(live.filePath)).resolves.toMatchObject({ size: 4 });
  });

  it("keeps expired file metadata claimable across later blob writes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const expired = await store.createStandaloneFileArtifact({ ttlMs: 1_000 });
    await fs.writeFile(expired.filePath, "expired");
    await store.completeFileArtifact(expired.id);

    await store.stopCleanup();
    await expireDiffArtifactForTest(rootDir, expired.id, 1_000);
    await blobStore.register(
      "later-write",
      new Uint8Array(),
      { version: 1, kind: "rendered_file", format: "png" },
      { ttlMs: 60_000 },
    );
    await store.cleanupExpired();

    await expect(fs.stat(path.dirname(expired.filePath))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("cleans expired rows and retries a quota-limited registration", async () => {
    const registerIfAbsent = blobStore.registerIfAbsent.bind(blobStore);
    const registerSpy = vi
      .spyOn(blobStore, "registerIfAbsent")
      .mockRejectedValueOnce(
        Object.assign(new Error("physical quota reached"), {
          code: "PLUGIN_BLOB_LIMIT_EXCEEDED",
        }),
      )
      .mockImplementation(registerIfAbsent);
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await store.createArtifact({
      html: "<html>retry</html>",
      title: "Retry",
      inputKind: "before_after",
      fileCount: 1,
    });

    expect(registerSpy).toHaveBeenCalledTimes(2);
    expect(cleanupSpy).toHaveBeenCalled();
  });

  it("looks up only old orphan candidates while preserving live files and the age boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-09-13T12:00:00Z");
    vi.setSystemTime(now);
    const day = 24 * 60 * 60 * 1_000;
    const directories = [
      { id: "a".repeat(20), age: day + 1_000, live: false },
      { id: "b".repeat(20), age: 1_000, live: false },
      { id: "c".repeat(20), age: day, live: false },
      { id: "d".repeat(20), age: day + 1_000, live: true },
      { id: "e".repeat(20), age: 1_000, live: true },
    ];
    for (const directory of directories) {
      const dir = path.join(rootDir, directory.id);
      await fs.mkdir(dir, { recursive: true });
      const time = new Date(now.getTime() - directory.age);
      await fs.utimes(dir, time, time);
      if (directory.live) {
        await blobStore.register(directory.id, new Uint8Array(), {
          version: 1,
          kind: "rendered_file",
          format: "png",
        });
      }
    }
    const lookup = vi.spyOn(blobStore, "lookup");
    try {
      await store.cleanupExpired();

      await expect(fs.stat(path.join(rootDir, "a".repeat(20)))).rejects.toMatchObject({
        code: "ENOENT",
      });
      for (const id of ["b", "c", "d", "e"]) {
        await expect(fs.stat(path.join(rootDir, id.repeat(20)))).resolves.toMatchObject({});
      }
      expect(lookup.mock.calls.length).toBeGreaterThan(0);
      expect(lookup.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      lookup.mockRestore();
    }
  });

  it("retains an old directory registered while its age is being checked", async () => {
    const id = "f".repeat(20);
    const dir = path.join(rootDir, id);
    await fs.mkdir(dir, { recursive: true });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await fs.utimes(dir, oldTime, oldTime);
    const stat = vi.spyOn(fs, "stat").mockImplementationOnce(async () => {
      await blobStore.register(id, new Uint8Array(), {
        version: 1,
        kind: "rendered_file",
        format: "png",
      });
      return await fs.lstat(dir);
    });
    try {
      await store.cleanupExpired();
    } finally {
      stat.mockRestore();
    }

    await expect(fs.stat(dir)).resolves.toMatchObject({});
    await expect(blobStore.lookup(id)).resolves.toMatchObject({ key: id });
  });

  it("preserves a rendering file after its blob expires until rendering completes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-09-13T12:00:00Z");
    vi.setSystemTime(now);
    const schedule = vi.spyOn(store, "scheduleCleanup").mockImplementation(() => undefined);
    let artifact: Awaited<ReturnType<DiffArtifactStore["createStandaloneFileArtifact"]>>;
    try {
      artifact = await store.createStandaloneFileArtifact({ format: "png", ttlMs: 1_000 });
    } finally {
      schedule.mockRestore();
    }
    await fs.writeFile(artifact.filePath, "rendering");
    const oldTime = new Date(now.getTime() - 25 * 60 * 60 * 1_000);
    await fs.utimes(path.dirname(artifact.filePath), oldTime, oldTime);
    await store.stopCleanup();
    await expireDiffArtifactForTest(rootDir, artifact.id, 1_000);
    vi.setSystemTime(new Date(now.getTime() + 2_000));

    await store.cleanupExpired();

    await expect(blobStore.lookup(artifact.id)).resolves.toBeUndefined();
    await expect(fs.readFile(artifact.filePath, "utf8")).resolves.toBe("rendering");
    await expect(store.completeFileArtifact(artifact.id)).rejects.toThrow();
    await expect(fs.stat(artifact.filePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throttles cleanup sweeps across repeated artifact creation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-02-27T16:00:00Z");
    vi.setSystemTime(now);
    store = new DiffArtifactStore({
      rootDir,
      blobStore,
      cleanupIntervalMs: 60_000,
    });
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await store.createArtifact({
      html: "<html>one</html>",
      title: "One",
      inputKind: "before_after",
      fileCount: 1,
    });
    await store.createArtifact({
      html: "<html>two</html>",
      title: "Two",
      inputKind: "before_after",
      fileCount: 1,
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(now.getTime() + 61_000));
    await store.createArtifact({
      html: "<html>three</html>",
      title: "Three",
      inputKind: "before_after",
      fileCount: 1,
    });

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });
});

describe("createDiffsHttpHandler", () => {
  const missingViewerPath = "/plugins/diffs/view/not-a-real-id/not-a-real-token";
  let store: DiffArtifactStore;
  let cleanupRootDir: () => Promise<void>;

  async function handleLocalGet(url: string) {
    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url,
      }),
      res,
    );
    return { handled, res };
  }

  beforeEach(async () => {
    ({ store, cleanup: cleanupRootDir } = await createDiffStoreHarness("openclaw-diffs-http-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await cleanupRootDir();
  });

  it("serves a stored diff document", async () => {
    const artifact = await createViewerArtifact(store);
    const { handled, res } = await handleLocalGet(artifact.viewerPath);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.body as unknown as Uint8Array).toString("utf8")).toBe(
      "<html>viewer</html>",
    );
    expect(res.getHeader("content-security-policy")).toContain("default-src 'none'");
    expect(res.getHeader("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects invalid tokens", async () => {
    const artifact = await createViewerArtifact(store);
    const { handled, res } = await handleLocalGet(
      artifact.viewerPath.replace(artifact.token, "bad-token"),
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it("rejects malformed artifact ids before reading from disk", async () => {
    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url: "/plugins/diffs/view/not-a-real-id/not-a-real-token",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it("serves the shared viewer asset", async () => {
    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url: "/plugins/diffs/assets/viewer.js",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("./viewer-runtime.js?v=");
    expect(res.getHeader("cache-control")).toBe("no-store, max-age=0");
  });

  it("serves the shared viewer runtime asset", async () => {
    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url: "/plugins/diffs/assets/viewer-runtime.js",
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("openclawDiffsReady");
    expect(res.getHeader("cache-control")).toBe("public, max-age=31536000, immutable");
  });

  it.each([
    {
      name: "allows direct loopback viewer access by default",
      request: localReq,
      allowRemoteViewer: false,
      expectedStatusCode: 200,
    },
    {
      name: "allows ipv4-mapped ipv6 loopback viewer access by default",
      request: ipv4MappedLoopbackReq,
      allowRemoteViewer: false,
      expectedStatusCode: 200,
    },
    {
      name: "blocks non-loopback viewer access by default",
      request: remoteReq,
      allowRemoteViewer: false,
      expectedStatusCode: 404,
    },
    {
      name: "blocks loopback requests that carry proxy forwarding headers by default",
      request: localReq,
      headers: { "x-forwarded-for": "203.0.113.10" },
      allowRemoteViewer: false,
      expectedStatusCode: 404,
    },
    {
      name: "blocks trusted-proxy loopback requests without client-origin headers by default",
      request: localReq,
      trustedProxies: ["127.0.0.1"],
      allowRemoteViewer: false,
      expectedStatusCode: 404,
    },
    {
      name: "blocks proxied loopback requests when trusted proxies are configured",
      request: localReq,
      headers: { "x-forwarded-for": "203.0.113.10" },
      trustedProxies: ["127.0.0.1"],
      allowRemoteViewer: false,
      expectedStatusCode: 404,
    },
    {
      name: "allows remote access when allowRemoteViewer is enabled",
      request: remoteReq,
      allowRemoteViewer: true,
      expectedStatusCode: 200,
    },
    {
      name: "allows proxied loopback requests when allowRemoteViewer is enabled",
      request: localReq,
      headers: { "x-forwarded-for": "203.0.113.10" },
      trustedProxies: ["127.0.0.1"],
      allowRemoteViewer: true,
      expectedStatusCode: 200,
    },
  ])(
    "$name",
    async ({ request, headers, trustedProxies, allowRemoteViewer, expectedStatusCode }) => {
      const artifact = await createViewerArtifact(store);

      const handler = createDiffsHttpHandler({ store, allowRemoteViewer, trustedProxies });
      const res = createMockServerResponse();
      const handled = await handler(
        request({
          method: "GET",
          url: artifact.viewerPath,
          headers,
        }),
        res,
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(expectedStatusCode);
      if (expectedStatusCode === 200) {
        expect(Buffer.from(res.body as unknown as Uint8Array).toString("utf8")).toBe(
          "<html>viewer</html>",
        );
      }
    },
  );

  it.each([
    ["127.0.0.1", 200],
    ["127.0.0.2", 200],
    ["127.255.255.254", 200],
    ["::1", 200],
    ["::ffff:127.0.0.2", 200],
    ["128.0.0.1", 404],
  ] as const)("classifies viewer client address %s", async (remoteAddress, expectedStatusCode) => {
    const artifact = await createViewerArtifact(store);
    const handler = createDiffsHttpHandler({ store, allowRemoteViewer: false });
    const res = createMockServerResponse();

    await handler(
      localReq({
        method: "GET",
        url: artifact.viewerPath,
        remoteAddress,
      }),
      res,
    );

    expect(res.statusCode).toBe(expectedStatusCode);
  });

  it("allows the at-capacity remote miss and blocks the next request", async () => {
    const handler = createDiffsHttpHandler({ store, allowRemoteViewer: true });

    for (let i = 0; i < 40; i++) {
      const miss = createMockServerResponse();
      await handler(
        remoteReq({
          method: "GET",
          url: missingViewerPath,
        }),
        miss,
      );
      expect(miss.statusCode).toBe(404);
    }

    const limited = createMockServerResponse();
    await handler(
      remoteReq({
        method: "GET",
        url: missingViewerPath,
      }),
      limited,
    );
    expect(limited.statusCode).toBe(429);
  });

  it("slides the remote failure window across the original window boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = new Date("2026-08-19T12:00:00Z").getTime();
    vi.setSystemTime(startedAt);
    const handler = createDiffsHttpHandler({ store, allowRemoteViewer: true });

    const recordMisses = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const miss = createMockServerResponse();
        await handler(remoteReq({ method: "GET", url: missingViewerPath }), miss);
        expect(miss.statusCode).toBe(404);
      }
    };

    await recordMisses(20);
    vi.setSystemTime(startedAt + 59_000);
    await recordMisses(19);
    vi.setSystemTime(startedAt + 61_000);
    await recordMisses(1);
    vi.setSystemTime(startedAt + 118_000);
    await recordMisses(20);

    const limited = createMockServerResponse();
    await handler(remoteReq({ method: "GET", url: missingViewerPath }), limited);
    expect(limited.statusCode).toBe(429);
  });

  it("keeps loopback viewer requests outside the remote failure limiter", async () => {
    const handler = createDiffsHttpHandler({ store, allowRemoteViewer: true });

    for (let i = 0; i < 41; i++) {
      const miss = createMockServerResponse();
      await handler(localReq({ method: "GET", url: missingViewerPath }), miss);
      expect(miss.statusCode).toBe(404);
    }
  });
});

async function createViewerArtifact(store: DiffArtifactStore) {
  return await store.createArtifact({
    html: "<html>viewer</html>",
    title: "Demo",
    inputKind: "before_after",
    fileCount: 1,
  });
}

function localReq(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  remoteAddress?: string;
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: input.remoteAddress ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function remoteReq(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "203.0.113.10" },
  } as unknown as IncomingMessage;
}

function ipv4MappedLoopbackReq(input: {
  method: string;
  url: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "::ffff:127.0.0.1" },
  } as unknown as IncomingMessage;
}

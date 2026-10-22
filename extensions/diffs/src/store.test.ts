import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginBlobStoreWithReceipts } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DiffArtifactStore } from "./store.js";
import {
  createDiffStoreHarness,
  ensureCuratedViewerRuntimeForTests,
  expireDiffArtifactForTest,
  registerDiffsHttpRouteForTest,
} from "./test-helpers.js";
import type { DiffArtifactBlobMetadata } from "./types.js";

const context = {
  agentId: "main",
  sessionId: "session-123",
  messageChannel: "discord",
  agentAccountId: "default",
};
const fileMetadata = { version: 1, kind: "rendered_file", format: "png" } as const;

function artifactToken(artifact: { viewerPath: string }): string {
  const token = artifact.viewerPath.split("/").at(-1);
  assert.isDefined(token);
  return token;
}

beforeAll(ensureCuratedViewerRuntimeForTests);

let rootDir: string;
let store: DiffArtifactStore;
let blobStore: PluginBlobStoreWithReceipts<DiffArtifactBlobMetadata>;
let reopenStore: Awaited<ReturnType<typeof createDiffStoreHarness>>["reopen"];
let cleanupRootDir: () => Promise<void>;

function setupStore(nativeKernel = false) {
  beforeEach(async () => {
    ({
      rootDir,
      store,
      blobStore,
      reopen: reopenStore,
      cleanup: cleanupRootDir,
    } = await createDiffStoreHarness("openclaw-diffs-store-", { nativeKernel }));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await cleanupRootDir();
  });
}

describe("DiffArtifactStore", () => {
  setupStore(true);
  const maximum = 64 * 1024 * 1024;

  it("rejects oversized input before token creation, registration or cleanup", async () => {
    const random = vi.spyOn(crypto, "randomBytes");
    const register = vi.spyOn(blobStore, "registerIfAbsentWithReceipt");
    const cleanup = vi.spyOn(store, "scheduleCleanup");
    await expect(createViewerArtifact(store, { html: "x".repeat(maximum + 1) })).rejects.toThrow(
      `Diff viewer HTML exceeds ${maximum} bytes.`,
    );
    expect(random).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it.each(["size-mismatch", "oversized-output"] as const)(
    "rejects %s with valid authorized metadata",
    async (kind) => {
      const artifact = await createViewerArtifact(store, { html: "viewer", inputKind: "patch" });
      const entry = await blobStore.lookup(artifact.id);
      assert.isDefined(entry);
      if (entry.metadata.kind !== "viewer") {
        throw new Error("Expected viewer metadata");
      }
      const bytes =
        kind === "oversized-output" ? gzipSync(Buffer.alloc(maximum + 1, 120)) : entry.bytes;
      const decodedBytes = kind === "oversized-output" ? maximum : Buffer.byteLength("viewer") + 1;
      await blobStore.register(artifact.id, bytes, { ...entry.metadata, decodedBytes });
      await expect(
        store.readAuthorizedViewer(artifact.id, artifactToken(artifact)),
      ).rejects.toBeInstanceOf(Error);
    },
  );
  it("reopens compressed viewer bytes and retrieves them with one authorized lookup", async () => {
    await store.stopCleanup();
    const registrationLookup = vi.spyOn(blobStore, "lookup");
    const artifact = await createViewerArtifact(store, {
      html: "<html>demo é 🦀</html>",
      context,
    });
    expect(registrationLookup).not.toHaveBeenCalled();
    registrationLookup.mockRestore();
    const stored = await blobStore.lookup(artifact.id);
    expect(Date.parse(artifact.expiresAt)).toBe(stored?.expiresAt);
    expect(stored?.metadata).toMatchObject({
      version: 1,
      kind: "viewer",
      encoding: "gzip",
      decodedBytes: Buffer.byteLength("<html>demo é 🦀</html>"),
      context,
    });
    expect(JSON.stringify(stored?.metadata)).not.toContain(artifactToken(artifact));
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });

    ({ store, blobStore } = await reopenStore());
    const lookup = vi.spyOn(blobStore, "lookup");
    const loaded = await store.readAuthorizedViewer(artifact.id, artifactToken(artifact));
    expect(Buffer.from(loaded!.html).toString("utf8")).toBe("<html>demo é 🦀</html>");
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(store.readAuthorizedViewer(artifact.id, "0".repeat(48))).resolves.toBeNull();
    await expect(store.readAuthorizedViewer(artifact.id, "short")).resolves.toBeNull();
  });

  it("caps artifact expiry instead of throwing near the Date boundary", async () => {
    await store.stopCleanup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(8_640_000_000_000_000 - 1_000);
    const artifact = await createViewerArtifact(store, { inputKind: "patch", ttlMs: 60_000 });

    expect(artifact.expiresAt).toBe("+275760-09-13T00:00:00.000Z");
    await expect(blobStore.lookup(artifact.id)).resolves.toMatchObject({
      createdAt: 8_640_000_000_000_000 - 1_000,
      expiresAt: 8_640_000_000_000_000,
    });
  });

  it("expires artifacts after the ttl", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const artifact = await createViewerArtifact(store, { ttlMs: 1_000 });

    await store.stopCleanup();
    await expireDiffArtifactForTest(rootDir, artifact.id, 1_000);
    await expect(
      store.readAuthorizedViewer(artifact.id, artifactToken(artifact)),
    ).resolves.toBeNull();
    await expect(blobStore.deleteExpired()).resolves.toEqual([]);
  });

  it("creates standalone file artifacts with SQLite metadata and derived temp paths", async () => {
    const standalone = await store.createStandaloneFileArtifact({
      context: { agentId: "main", sessionId: "session-123" },
    });
    expect(standalone.filePath).toMatch(/preview\.png$/);
    expect(standalone.filePath).toContain(rootDir);
    expect(Date.parse(standalone.expiresAt)).toBeGreaterThan(Date.now());
    await expect(blobStore.lookup(standalone.id)).resolves.toMatchObject({
      key: standalone.id,
      sizeBytes: 0,
      metadata: { ...fileMetadata, context: { agentId: "main", sessionId: "session-123" } },
    });
    await store.completeFileArtifact(standalone.id);
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

  it("cleans expired rows and retries a quota-limited registration", async () => {
    const registerIfAbsent = blobStore.registerIfAbsentWithReceipt.bind(blobStore);
    const registerSpy = vi
      .spyOn(blobStore, "registerIfAbsentWithReceipt")
      .mockRejectedValueOnce(
        Object.assign(new Error("quota"), { code: "PLUGIN_BLOB_LIMIT_EXCEEDED" }),
      )
      .mockImplementation(registerIfAbsent);
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await createViewerArtifact(store, { html: "<html>retry</html>", title: "Retry" });

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
        await blobStore.register(directory.id, new Uint8Array(), fileMetadata);
      }
    }
    const lookup = vi.spyOn(blobStore, "lookup");
    await store.cleanupExpired();

    await expect(fs.stat(path.join(rootDir, "a".repeat(20)))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const id of ["b", "c", "d", "e"]) {
      await expect(fs.stat(path.join(rootDir, id.repeat(20)))).resolves.toMatchObject({});
    }
    expect(lookup.mock.calls.length).toBeGreaterThan(0);
    expect(lookup.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("retains an old directory registered while its age is being checked", async () => {
    const id = "f".repeat(20);
    const dir = path.join(rootDir, id);
    await fs.mkdir(dir, { recursive: true });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1_000);
    await fs.utimes(dir, oldTime, oldTime);
    const stat = vi.spyOn(fs, "stat").mockImplementationOnce(async () => {
      await blobStore.register(id, new Uint8Array(), fileMetadata);
      return await fs.lstat(dir);
    });
    await store.cleanupExpired();
    stat.mockRestore();

    await expect(fs.stat(dir)).resolves.toMatchObject({});
    await expect(blobStore.lookup(id)).resolves.toMatchObject({ key: id });
  });

  it("preserves a rendering file after its blob expires until rendering completes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const now = new Date("2026-09-13T12:00:00Z");
    vi.setSystemTime(now);
    const schedule = vi.spyOn(store, "scheduleCleanup").mockImplementation(() => undefined);
    const artifact = await store.createStandaloneFileArtifact({ format: "png", ttlMs: 1_000 });
    schedule.mockRestore();
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
    store = new DiffArtifactStore({ rootDir, blobStore });
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await createViewerArtifact(store, { html: "<html>one</html>", title: "One" });
    await createViewerArtifact(store, { html: "<html>two</html>", title: "Two" });

    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(now.getTime() + 301_000));
    await createViewerArtifact(store, { html: "<html>three</html>", title: "Three" });

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });
});

describe("registered Diffs viewer route", () => {
  const missingViewerPath = "/plugins/diffs/view/not-a-real-id/not-a-real-token";
  setupStore();

  function client(
    access: Pick<
      NonNullable<OpenClawConfig["gateway"]>,
      "trustedProxies" | "allowRealIpFallback"
    > & {
      allowRemoteViewer?: boolean;
    } = {},
    remoteAddress = "127.0.0.1",
  ) {
    const handler = registerDiffsHttpRouteForTest({
      stateDir: path.join(path.dirname(rootDir), "state"),
      config: {
        gateway: {
          trustedProxies: access.trustedProxies,
          allowRealIpFallback: access.allowRealIpFallback,
        },
        plugins: {
          entries: {
            diffs: { config: { security: { allowRemoteViewer: access.allowRemoteViewer } } },
          },
        },
      },
    });
    return (url: string, headers?: Record<string, string>) =>
      get(handler, {
        method: "GET",
        url,
        headers: headers ?? {},
        socket: { remoteAddress },
      } as unknown as IncomingMessage);
  }

  it("serves a stored diff document", async () => {
    const artifact = await createViewerArtifact(store);
    const res = await client()(artifact.viewerPath);

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toBe("<html>viewer</html>");
    expect(res.getHeader("content-security-policy")).toContain("default-src 'none'");
    expect(res.getHeader("cache-control")).toBe("no-store, max-age=0");
  });

  it("rejects invalid tokens", async () => {
    const artifact = await createViewerArtifact(store);
    const res = await client()(artifact.viewerPath.replace(artifactToken(artifact), "bad-token"));

    expect(res.statusCode).toBe(404);
  });

  it("serves the shared viewer asset", async () => {
    const res = await client()("/plugins/diffs/assets/viewer.js");

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toContain("./viewer-runtime.js?v=");
    expect(res.getHeader("cache-control")).toBe("no-store, max-age=0");
  });

  it.each([
    ["blocks non-loopback viewer access by default", "203.0.113.10", false, false, false, 404],
    ["blocks loopback with proxy headers by default", "127.0.0.1", true, false, false, 404],
    ["blocks trusted proxy without client-origin headers", "127.0.0.1", false, true, false, 404],
    ["blocks proxied loopback with trusted proxies", "127.0.0.1", true, true, false, 404],
    ["allows proxied loopback with allowRemoteViewer", "127.0.0.1", true, true, true, 200],
  ] as const)(
    "%s",
    async (_name, remoteAddress, forwarded, trusted, allowRemoteViewer, expectedStatusCode) => {
      const artifact = await createViewerArtifact(store);

      const request = client(
        { allowRemoteViewer, trustedProxies: trusted ? ["127.0.0.1"] : undefined },
        remoteAddress,
      );
      const res = await request(
        artifact.viewerPath,
        forwarded ? { "x-forwarded-for": "203.0.113.10" } : undefined,
      );

      expect(res.statusCode).toBe(expectedStatusCode);
    },
  );

  it.each([
    ["127.0.0.2", 200],
    ["::1", 200],
    ["::ffff:127.0.0.2", 200],
  ] as const)("classifies viewer client address %s", async (remoteAddress, expectedStatusCode) => {
    const artifact = await createViewerArtifact(store);
    const res = await client({ allowRemoteViewer: false }, remoteAddress)(artifact.viewerPath);

    expect(res.statusCode).toBe(expectedStatusCode);
  });

  it("slides the remote failure window across the original window boundary", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = new Date("2026-08-19T12:00:00Z").getTime();
    vi.setSystemTime(startedAt);
    const request = client({ allowRemoteViewer: true }, "203.0.113.10");

    const recordMisses = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const miss = await request(missingViewerPath);
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

    const limited = await request(missingViewerPath);
    expect(limited.statusCode).toBe(429);
  });

  it("keeps loopback viewer requests outside the remote failure limiter", async () => {
    const request = client({ allowRemoteViewer: true });

    for (let i = 0; i < 41; i++) {
      const miss = await request(missingViewerPath);
      expect(miss.statusCode).toBe(404);
    }
  });
});

async function get(handler: OpenClawPluginHttpRouteHandler, request: IncomingMessage) {
  const res = createMockServerResponse();
  expect(await handler(request, res)).toBe(true);
  return res;
}

async function createViewerArtifact(
  artifactStore: DiffArtifactStore,
  overrides: Partial<Parameters<DiffArtifactStore["createArtifact"]>[0]> = {},
) {
  return await artifactStore.createArtifact({
    html: "<html>viewer</html>",
    title: "Demo",
    inputKind: "before_after",
    fileCount: 1,
    ...overrides,
  });
}

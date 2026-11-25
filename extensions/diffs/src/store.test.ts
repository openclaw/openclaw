import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { createMockServerResponse } from "openclaw/plugin-sdk/test-env";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffArtifactStore } from "./store.js";
import {
  createDiffStoreHarness,
  diffContext as context,
  expireDiffArtifactForTest,
  registerDiffsHttpRouteForTest,
} from "./test-helpers.js";

const fileMetadata = { version: 1, kind: "rendered_file", format: "png" } as const;

function artifactToken(artifact: { viewerPath: string }): string {
  return artifact.viewerPath.slice(artifact.viewerPath.lastIndexOf("/") + 1);
}

let rootDir: string;
let store: DiffArtifactStore;
let fixture: Awaited<ReturnType<typeof createDiffStoreHarness>>;
let blobStore: typeof fixture.blobStore;

function setupStore(nativeKernel = false) {
  beforeEach(async () => {
    fixture = await createDiffStoreHarness("openclaw-diffs-store-", { nativeKernel });
    ({ rootDir, store, blobStore } = fixture);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await fixture.cleanup();
  });
}

describe("DiffArtifactStore", () => {
  setupStore(true);
  const maximum = 64 * 1024 * 1024;

  it("rejects oversized input without storing an artifact", async () => {
    await expect(viewer({ html: "x".repeat(maximum + 1) })).rejects.toThrow(
      `Diff viewer HTML exceeds ${maximum} bytes.`,
    );
    await expect(blobStore.entries()).resolves.toEqual([]);
  });

  it.each(["size-mismatch", "oversized-output"] as const)(
    "rejects %s with valid authorized metadata",
    async (kind) => {
      const artifact = await viewer({ html: "viewer", inputKind: "patch" });
      const entry = await blobStore.lookup(artifact.id);
      assert.isDefined(entry);
      if (entry.metadata.kind !== "viewer") {
        throw new Error("Expected viewer metadata");
      }
      const bytes =
        kind === "oversized-output" ? gzipSync(Buffer.alloc(maximum + 1, 120)) : entry.bytes;
      const decodedBytes = kind === "oversized-output" ? maximum : Buffer.byteLength("viewer") + 1;
      await blobStore.register(artifact.id, bytes, { ...entry.metadata, decodedBytes });
      await expect(read(artifact)).rejects.toBeInstanceOf(Error);
    },
  );
  it("reopens, authorizes, and expires compressed viewers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await store.stopCleanup();
    const artifact = await viewer({
      html: "<html>demo é 🦀</html>",
      context,
      ttlMs: 1_000,
    });
    const stored = await blobStore.lookup(artifact.id);
    expect(Date.parse(artifact.expiresAt)).toBe(stored?.expiresAt);
    expect(stored?.metadata.context).toEqual(context);
    expect(JSON.stringify(stored?.metadata)).not.toContain(artifactToken(artifact));
    await expect(fs.stat(rootDir)).rejects.toMatchObject({ code: "ENOENT" });

    ({ store, blobStore } = await fixture.reopen());
    const lookup = vi.spyOn(blobStore, "lookup");
    const loaded = await read(artifact);
    expect(Buffer.from(loaded!.html).toString("utf8")).toBe("<html>demo é 🦀</html>");
    expect(lookup).toHaveBeenCalledTimes(1);
    await expect(read(artifact, "0".repeat(48))).resolves.toBeNull();
    await expect(read(artifact, "short")).resolves.toBeNull();
    await expireDiffArtifactForTest(rootDir, artifact.id, 1_000);
    await expect(read(artifact)).resolves.toBeNull();
    await expect(blobStore.deleteExpired()).resolves.toEqual([]);
  });

  it("caps artifact expiry instead of throwing near the Date boundary", async () => {
    await store.stopCleanup();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(8_640_000_000_000_000 - 1_000);
    const artifact = await viewer({ inputKind: "patch", ttlMs: 60_000 });

    expect(artifact.expiresAt).toBe("+275760-09-13T00:00:00.000Z");
    await expect(blobStore.lookup(artifact.id)).resolves.toMatchObject({
      createdAt: 8_640_000_000_000_000 - 1_000,
      expiresAt: 8_640_000_000_000_000,
    });
  });

  it("cleans expired rows and retries a quota-limited registration", async () => {
    vi.spyOn(blobStore, "registerIfAbsentWithReceipt").mockRejectedValueOnce(
      Object.assign(new Error("quota"), { code: "PLUGIN_BLOB_LIMIT_EXCEEDED" }),
    );
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await expect(viewer()).resolves.toMatchObject({ title: "Demo" });
    expect(cleanupSpy).toHaveBeenCalled();
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
    const cleanupSpy = vi.spyOn(store, "cleanupExpired").mockResolvedValue();

    await viewer({ html: "<html>one</html>", title: "One" });
    await viewer({ html: "<html>two</html>", title: "Two" });

    expect(cleanupSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(now.getTime() + 301_000));
    await viewer({ html: "<html>three</html>", title: "Three" });

    expect(cleanupSpy).toHaveBeenCalledTimes(2);
  });
});

describe("registered Diffs viewer route", () => {
  const missingViewerPath = "/plugins/diffs/view/not-a-real-id/not-a-real-token";
  setupStore();

  function client(
    access: { trustedProxies?: string[]; allowRemoteViewer?: boolean } = {},
    remoteAddress = "127.0.0.1",
  ) {
    const handler = registerDiffsHttpRouteForTest({
      stateDir: path.join(path.dirname(rootDir), "state"),
      config: {
        gateway: {
          trustedProxies: access.trustedProxies,
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
    const artifact = await viewer();
    const res = await client()(artifact.viewerPath);

    expect(res.statusCode).toBe(200);
    expect(String(res.body)).toBe("<html>viewer</html>");
    expect(res.getHeader("content-security-policy")).toContain("default-src 'none'");
    expect(res.getHeader("cache-control")).toBe("no-store, max-age=0");
  });

  it.each([
    ["invalid token", "127.0.0.1", false, false, false, 404, true],
    ["non-loopback", "203.0.113.10", false, false, false, 404, false],
    ["loopback with proxy headers", "127.0.0.1", true, false, false, 404, false],
    ["trusted proxy without origin headers", "127.0.0.1", false, true, false, 404, false],
    ["proxied loopback", "127.0.0.1", true, true, false, 404, false],
    ["explicit remote access", "127.0.0.1", true, true, true, 200, false],
    ["IPv4 loopback", "127.0.0.2", false, false, false, 200, false],
    ["IPv6 loopback", "::1", false, false, false, 200, false],
    ["mapped loopback", "::ffff:127.0.0.2", false, false, false, 200, false],
  ] as const)(
    "checks viewer access: %s",
    async (
      _name,
      remoteAddress,
      forwarded,
      trusted,
      allowRemoteViewer,
      expectedStatusCode,
      badToken,
    ) => {
      const artifact = await viewer();

      const request = client(
        { allowRemoteViewer, trustedProxies: trusted ? ["127.0.0.1"] : undefined },
        remoteAddress,
      );
      const res = await request(
        badToken
          ? artifact.viewerPath.replace(artifactToken(artifact), "bad-token")
          : artifact.viewerPath,
        forwarded ? { "x-forwarded-for": "203.0.113.10" } : undefined,
      );

      expect(res.statusCode).toBe(expectedStatusCode);
    },
  );

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

function viewer(overrides: Partial<Parameters<DiffArtifactStore["createArtifact"]>[0]> = {}) {
  return store.createArtifact({
    html: "<html>viewer</html>",
    title: "Demo",
    inputKind: "before_after",
    fileCount: 1,
    ...overrides,
  });
}

const read = (artifact: { id: string; viewerPath: string }, token = artifactToken(artifact)) =>
  store.readAuthorizedViewer(artifact.id, token);

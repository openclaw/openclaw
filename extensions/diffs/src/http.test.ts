import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockServerResponse } from "../../../src/test-utils/mock-http-response.js";
import { createDiffsHttpHandler } from "./http.js";
import { DiffArtifactStore } from "./store.js";

describe("createDiffsHttpHandler", () => {
  let rootDir: string;
  let store: DiffArtifactStore;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-diffs-http-"));
    store = new DiffArtifactStore({ rootDir });
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("serves a stored diff document", async () => {
    const artifact = await store.createArtifact({
      html: "<html>viewer</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url: artifact.viewerPath,
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<html>viewer</html>");
    expect(res.getHeader("content-security-policy")).toContain("default-src 'none'");
  });

  it("rejects invalid tokens", async () => {
    const artifact = await store.createArtifact({
      html: "<html>viewer</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      localReq({
        method: "GET",
        url: artifact.viewerPath.replace(artifact.token, "bad-token"),
      }),
      res,
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
    expect(String(res.body)).toContain("/plugins/diffs/assets/viewer-runtime.js?v=");
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
  });

  it("blocks non-loopback viewer access by default", async () => {
    const artifact = await store.createArtifact({
      html: "<html>viewer</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const handler = createDiffsHttpHandler({ store });
    const res = createMockServerResponse();
    const handled = await handler(
      remoteReq({
        method: "GET",
        url: artifact.viewerPath,
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it("allows remote access when allowRemoteViewer is enabled", async () => {
    const artifact = await store.createArtifact({
      html: "<html>viewer</html>",
      title: "Demo",
      inputKind: "before_after",
      fileCount: 1,
    });

    const handler = createDiffsHttpHandler({ store, allowRemoteViewer: true });
    const res = createMockServerResponse();
    const handled = await handler(
      remoteReq({
        method: "GET",
        url: artifact.viewerPath,
      }),
      res,
    );

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<html>viewer</html>");
  });

  it("rate-limits repeated remote misses", async () => {
    const handler = createDiffsHttpHandler({ store, allowRemoteViewer: true });

    for (let i = 0; i < 40; i++) {
      const miss = createMockServerResponse();
      await handler(
        remoteReq({
          method: "GET",
          url: "/plugins/diffs/view/aaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        }),
        miss,
      );
      expect(miss.statusCode).toBe(404);
    }

    const limited = createMockServerResponse();
    await handler(
      remoteReq({
        method: "GET",
        url: "/plugins/diffs/view/aaaaaaaaaaaaaaaaaaaa/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
      limited,
    );
    expect(limited.statusCode).toBe(429);
  });
});

function localReq(input: { method: string; url: string }): IncomingMessage {
  return {
    ...input,
    socket: { remoteAddress: "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function remoteReq(input: { method: string; url: string }): IncomingMessage {
  return {
    ...input,
    socket: { remoteAddress: "203.0.113.10" },
  } as unknown as IncomingMessage;
}

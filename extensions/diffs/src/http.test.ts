import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMockServerResponse } from "../../../src/test-utils/mock-http-response.js";
import { createDiffsHttpHandler } from "./http.js";
import { DiffArtifactStore } from "./store.js";
import { createDiffStoreHarness } from "./test-helpers.js";

describe("createDiffsHttpHandler", () => {
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
    await cleanupRootDir();
  });

  it("serves a stored diff document", async () => {
    const artifact = await createViewerArtifact(store);
    const { handled, res } = await handleLocalGet(artifact.viewerPath);

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("<html>viewer</html>");
    expect(res.getHeader("content-security-policy")).toContain("default-src 'none'");
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

  it.each([
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
      name: "allows remote access when allowRemoteViewer is enabled",
      request: remoteReq,
      allowRemoteViewer: true,
      expectedStatusCode: 200,
    },
    {
      name: "allows proxied loopback requests when allowRemoteViewer is enabled",
      request: localReq,
      headers: { "x-forwarded-for": "203.0.113.10" },
      allowRemoteViewer: true,
      expectedStatusCode: 200,
    },
  ])("$name", async ({ request, headers, allowRemoteViewer, expectedStatusCode }) => {
    const artifact = await createViewerArtifact(store);

    const handler = createDiffsHttpHandler({ store, allowRemoteViewer });
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
      expect(res.body).toBe("<html>viewer</html>");
    }
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
}): IncomingMessage {
  return {
    ...input,
    headers: input.headers ?? {},
    socket: { remoteAddress: "127.0.0.1" },
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

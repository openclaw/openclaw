import { createServer } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createDiffStoreHarness,
  ensureCuratedViewerRuntimeForTests,
  registerDiffsHttpRouteForTest,
} from "./test-helpers.js";

let base: string;
let fixture: Awaited<ReturnType<typeof createDiffStoreHarness>>;
const server = createServer();

beforeAll(async () => {
  await ensureCuratedViewerRuntimeForTests();
  fixture = await createDiffStoreHarness("openclaw-diffs-http-");
  const handler = registerDiffsHttpRouteForTest({
    stateDir: path.join(path.dirname(fixture.rootDir), "state"),
  });
  server.on("request", (req, res) => {
    void Promise.resolve(handler(req, res)).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  try {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  } finally {
    await fixture?.cleanup();
  }
});

async function fetchServed(requestPath: string, method = "GET") {
  const response = await fetch(`${base}${requestPath}`, { method });
  return {
    status: response.status,
    contentLength: response.headers.get("content-length"),
    bodyBytes: (await response.arrayBuffer()).byteLength,
  };
}

it("sends byte-accurate Content-Length on HEAD asset responses", async () => {
  const requestPath = "/plugins/diffs/assets/viewer-runtime.js";
  const get = await fetchServed(requestPath);
  expect(get.status).toBe(200);
  expect(get.bodyBytes).toBeGreaterThan(0);
  expect(get.contentLength).toBe(String(get.bodyBytes));
  expect(await fetchServed(requestPath, "HEAD")).toEqual({
    status: 200,
    bodyBytes: 0,
    contentLength: String(get.bodyBytes),
  });
});

it.each([
  ["/plugins/diffs/assets/does-not-exist.js", "Asset not found"],
  ["/plugins/diffs/view/not-an-artifact/not-a-token", "Diff not found"],
])("sends Content-Length on HEAD 404 for %s", async (requestPath, body) => {
  expect(await fetchServed(requestPath, "HEAD")).toEqual({
    status: 404,
    bodyBytes: 0,
    contentLength: String(Buffer.byteLength(body)),
  });
});

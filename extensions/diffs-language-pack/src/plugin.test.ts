import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import type { OpenClawPluginHttpRouteHandler } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it } from "vitest";
import { registerDiffsLanguagePackPlugin } from "./plugin.js";

const VIEWER_RUNTIME_PATH = "/plugins/diffs-language-pack/assets/viewer-runtime.js";
const UNKNOWN_ASSET_PATH = "/plugins/diffs-language-pack/assets/does-not-exist.js";

beforeAll(async () => {
  try {
    await fs.stat(new URL("../assets/viewer-runtime.js", import.meta.url));
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  // Build the ignored runtime asset when testing a clean checkout.
  await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "scripts/build-diffs-viewer-runtime.mts", "full"],
    { cwd: new URL("../../../", import.meta.url) },
  );
}, 120_000);

async function withLanguagePackServer(run: (base: string) => Promise<void>): Promise<void> {
  let registeredHttpRouteHandler: OpenClawPluginHttpRouteHandler | undefined;
  const api = createTestPluginApi({
    registerHttpRoute(params) {
      registeredHttpRouteHandler = params.handler;
    },
  });
  registerDiffsLanguagePackPlugin(api);
  const handler = registeredHttpRouteHandler;
  if (!handler) {
    throw new Error("expected the plugin to register an HTTP route");
  }
  await withServer((req, res) => {
    void Promise.resolve(handler(req, res)).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  }, run);
}

async function fetchServed(base: string, requestPath: string, method = "GET") {
  const response = await fetch(`${base}${requestPath}`, { method });
  const body = await response.arrayBuffer();
  return {
    status: response.status,
    contentLength: response.headers.get("content-length"),
    bodyBytes: body.byteLength,
  };
}

describe("diffs-language-pack viewer http handler", () => {
  it("sends byte-accurate Content-Length on HEAD asset responses", async () => {
    await withLanguagePackServer(async (base) => {
      const get = await fetchServed(base, VIEWER_RUNTIME_PATH);
      const head = await fetchServed(base, VIEWER_RUNTIME_PATH, "HEAD");

      expect(get.status).toBe(200);
      expect(get.bodyBytes).toBeGreaterThan(0);
      expect(get.contentLength).toBe(String(get.bodyBytes));
      expect(head.status).toBe(200);
      expect(head.bodyBytes).toBe(0);
      expect(head.contentLength).toBe(String(get.bodyBytes));
    });
  });

  it("sends Content-Length on HEAD 404 responses for missing assets", async () => {
    await withLanguagePackServer(async (base) => {
      const head = await fetchServed(base, UNKNOWN_ASSET_PATH, "HEAD");

      expect(head.status).toBe(404);
      expect(head.bodyBytes).toBe(0);
      expect(head.contentLength).toBe(String(Buffer.byteLength("Asset not found")));
    });
  });
});

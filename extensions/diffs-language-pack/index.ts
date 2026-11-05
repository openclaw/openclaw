import crypto from "node:crypto";
import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const VIEWER_ASSET_PREFIX = "/plugins/diffs-language-pack/assets/";
const VIEWER_LOADER_PATH = `${VIEWER_ASSET_PREFIX}viewer.js`;
const VIEWER_RUNTIME_PATH = `${VIEWER_ASSET_PREFIX}viewer-runtime.js`;
const VIEWER_RUNTIME_RELATIVE_IMPORT_PATH = "./viewer-runtime.js";
const VIEWER_RUNTIME_CANDIDATE_RELATIVE_PATHS = [
  "./src/assets/viewer-runtime.js",
  "./assets/viewer-runtime.js",
] as const;
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

type RuntimeAssetCache = {
  runtimeBody: Buffer;
  loaderBody: string;
};

let runtimeAssetCache: RuntimeAssetCache | null = null;

async function readViewerRuntime(): Promise<Buffer> {
  let missingFileError: Error | null = null;

  for (const relativePath of VIEWER_RUNTIME_CANDIDATE_RELATIVE_PATHS) {
    try {
      return await fs.readFile(new URL(relativePath, import.meta.url));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        missingFileError = error;
        continue;
      }
      throw error;
    }
  }

  if (missingFileError) {
    throw missingFileError;
  }

  throw new Error("viewer runtime asset candidates were not checked");
}

async function loadViewerAssets(): Promise<RuntimeAssetCache> {
  if (runtimeAssetCache) {
    return runtimeAssetCache;
  }

  const runtimeBody = await readViewerRuntime();
  const hash = crypto.createHash("sha1").update(runtimeBody).digest("hex").slice(0, 12);
  runtimeAssetCache = {
    runtimeBody,
    loaderBody: `import "${VIEWER_RUNTIME_RELATIVE_IMPORT_PATH}?v=${hash}";\n`,
  };
  return runtimeAssetCache;
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  setSharedHeaders(res, "text/plain; charset=utf-8");
  // Node suppresses the HEAD body but never synthesizes Content-Length; set it
  // explicitly so error responses keep GET/HEAD header parity (RFC 9110 §8.6).
  res.setHeader("content-length", String(Buffer.byteLength(body)));
  res.end(body);
}

function setSharedHeaders(
  res: ServerResponse,
  contentType: string,
  cacheControl = "no-store, max-age=0",
): void {
  res.setHeader("cache-control", cacheControl);
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

export default definePluginEntry({
  id: "diffs-language-pack",
  name: "Diff Viewer Language Pack",
  description: "Adds syntax highlighting for languages outside the default diffs viewer set.",
  register(api) {
    api.registerHttpRoute({
      path: "/plugins/diffs-language-pack",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res): Promise<boolean> => {
        const parsed = req.url ? URL.parse(req.url, "http://127.0.0.1") : null;
        if (!parsed?.pathname.startsWith(VIEWER_ASSET_PREFIX)) {
          return false;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          respondText(res, 405, "Method not allowed");
          return true;
        }

        if (parsed.pathname !== VIEWER_LOADER_PATH && parsed.pathname !== VIEWER_RUNTIME_PATH) {
          respondText(res, 404, "Asset not found");
          return true;
        }

        const assets = await loadViewerAssets();
        const body =
          parsed.pathname === VIEWER_LOADER_PATH ? assets.loaderBody : assets.runtimeBody;
        res.statusCode = 200;
        setSharedHeaders(
          res,
          "text/javascript; charset=utf-8",
          parsed.pathname === VIEWER_RUNTIME_PATH ? IMMUTABLE_ASSET_CACHE_CONTROL : undefined,
        );
        res.setHeader("content-length", String(Buffer.byteLength(body)));
        if (req.method === "HEAD") {
          res.end();
        } else {
          res.end(body);
        }
        return true;
      },
    });
  },
});

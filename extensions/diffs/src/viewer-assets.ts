import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const VIEWER_ASSET_PREFIX = "/plugins/diffs/assets/";
export const VIEWER_LOADER_PATH = `${VIEWER_ASSET_PREFIX}viewer.js`;
export const VIEWER_RUNTIME_PATH = `${VIEWER_ASSET_PREFIX}viewer-runtime.js`;

const VIEWER_RUNTIME_FILE_URL = new URL("../assets/viewer-runtime.js", import.meta.url);

export type ServedViewerAsset = {
  body: string | Buffer;
  contentType: string;
};

type RuntimeAssetCache = {
  mtimeMs: number;
  runtimeBody: Buffer;
  loaderBody: string;
};

let runtimeAssetCache: RuntimeAssetCache | null = null;

export async function getServedViewerAsset(pathname: string): Promise<ServedViewerAsset | null> {
  if (pathname !== VIEWER_LOADER_PATH && pathname !== VIEWER_RUNTIME_PATH) {
    return null;
  }

  const assets = await loadViewerAssets();
  if (pathname === VIEWER_LOADER_PATH) {
    return {
      body: assets.loaderBody,
      contentType: "text/javascript; charset=utf-8",
    };
  }

  if (pathname === VIEWER_RUNTIME_PATH) {
    return {
      body: assets.runtimeBody,
      contentType: "text/javascript; charset=utf-8",
    };
  }

  return null;
}

async function loadViewerAssets(): Promise<RuntimeAssetCache> {
  const runtimePath = fileURLToPath(VIEWER_RUNTIME_FILE_URL);
  const runtimeStat = await fs.stat(runtimePath);
  if (runtimeAssetCache && runtimeAssetCache.mtimeMs === runtimeStat.mtimeMs) {
    return runtimeAssetCache;
  }

  const runtimeBody = await fs.readFile(runtimePath);
  const hash = crypto.createHash("sha1").update(runtimeBody).digest("hex").slice(0, 12);
  runtimeAssetCache = {
    mtimeMs: runtimeStat.mtimeMs,
    runtimeBody,
    loaderBody: `import "${VIEWER_RUNTIME_PATH}?v=${hash}";\n`,
  };
  return runtimeAssetCache;
}

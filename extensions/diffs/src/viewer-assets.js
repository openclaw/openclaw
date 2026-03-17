import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
const VIEWER_ASSET_PREFIX = "/plugins/diffs/assets/";
const VIEWER_LOADER_PATH = `${VIEWER_ASSET_PREFIX}viewer.js`;
const VIEWER_RUNTIME_PATH = `${VIEWER_ASSET_PREFIX}viewer-runtime.js`;
const VIEWER_RUNTIME_FILE_URL = new URL("../assets/viewer-runtime.js", import.meta.url);
let runtimeAssetCache = null;
async function getServedViewerAsset(pathname) {
  if (pathname !== VIEWER_LOADER_PATH && pathname !== VIEWER_RUNTIME_PATH) {
    return null;
  }
  const assets = await loadViewerAssets();
  if (pathname === VIEWER_LOADER_PATH) {
    return {
      body: assets.loaderBody,
      contentType: "text/javascript; charset=utf-8"
    };
  }
  if (pathname === VIEWER_RUNTIME_PATH) {
    return {
      body: assets.runtimeBody,
      contentType: "text/javascript; charset=utf-8"
    };
  }
  return null;
}
async function loadViewerAssets() {
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
    loaderBody: `import "${VIEWER_RUNTIME_PATH}?v=${hash}";
`
  };
  return runtimeAssetCache;
}
export {
  VIEWER_ASSET_PREFIX,
  VIEWER_LOADER_PATH,
  VIEWER_RUNTIME_PATH,
  getServedViewerAsset
};

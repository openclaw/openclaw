import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const VIEWER_ASSET_PREFIX = "/plugins/diffs/assets/";
export const VIEWER_RUNTIME_PATH = `${VIEWER_ASSET_PREFIX}viewer-runtime.js`;
export const LANGUAGE_PACK_VIEWER_ASSET_PREFIX = "/plugins/diffs-language-pack/assets/";
const VIEWER_RUNTIME_RELATIVE_IMPORT_PATH = "./viewer-runtime.js";
// Unified builds hoist this module to the dist root while plugin assets stay under dist/extensions.
// Keep those candidates last so package and source layouts retain their first-hit paths.
const VIEWER_RUNTIME_CANDIDATE_RELATIVE_PATHS = [
  "./assets/viewer-runtime.js",
  "../assets/viewer-runtime.js",
  "./extensions/diffs/assets/viewer-runtime.js",
] as const;
const LANGUAGE_PACK_RUNTIME_CANDIDATE_RELATIVE_PATHS = [
  "../../diffs-language-pack/assets/viewer-runtime.js",
  "../diffs-language-pack/assets/viewer-runtime.js",
  "./extensions/diffs-language-pack/assets/viewer-runtime.js",
] as const;

type ServedViewerAsset = {
  body: string | Buffer;
  contentType: string;
};

type RuntimeAssetCache = {
  mtimeMs: number;
  runtimeBody: Buffer;
  loaderBody: string;
};

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export const getServedViewerAsset = createViewerAssetHandler(
  VIEWER_ASSET_PREFIX,
  VIEWER_RUNTIME_CANDIDATE_RELATIVE_PATHS,
);
export const getServedLanguagePackViewerAsset = createViewerAssetHandler(
  LANGUAGE_PACK_VIEWER_ASSET_PREFIX,
  LANGUAGE_PACK_RUNTIME_CANDIDATE_RELATIVE_PATHS,
  true,
);

function createViewerAssetHandler(
  prefix: string,
  relativePaths: readonly string[],
  optional = false,
): (pathname: string) => Promise<ServedViewerAsset | null> {
  const loaderPath = `${prefix}viewer.js`;
  const runtimePath = `${prefix}viewer-runtime.js`;
  let cache: RuntimeAssetCache | null = null;

  return async (pathname) => {
    if (pathname !== loaderPath && pathname !== runtimePath) {
      return null;
    }
    try {
      const runtimeUrl = await resolveRuntimeFileUrl(relativePaths);
      const assets = await loadRuntimeAssets({
        runtimeUrl,
        cache,
        updateCache: (updated) => {
          cache = updated;
        },
      });
      return {
        body: pathname === loaderPath ? assets.loaderBody : assets.runtimeBody,
        contentType: "text/javascript; charset=utf-8",
      };
    } catch (error) {
      if (optional && isMissingFileError(error)) {
        return null;
      }
      throw error;
    }
  };
}

async function loadRuntimeAssets(params: {
  cache: RuntimeAssetCache | null;
  runtimeUrl: URL;
  updateCache(cache: RuntimeAssetCache): void;
}): Promise<RuntimeAssetCache> {
  const runtimePath = fileURLToPath(params.runtimeUrl);
  const runtimeStat = await fs.stat(runtimePath);
  if (params.cache && params.cache.mtimeMs === runtimeStat.mtimeMs) {
    return params.cache;
  }

  const runtimeBody = await fs.readFile(runtimePath);
  const hash = crypto.createHash("sha1").update(runtimeBody).digest("hex").slice(0, 12);
  const cache = {
    mtimeMs: runtimeStat.mtimeMs,
    runtimeBody,
    loaderBody: `import "${VIEWER_RUNTIME_RELATIVE_IMPORT_PATH}?v=${hash}";\n`,
  };
  params.updateCache(cache);
  return cache;
}

async function resolveRuntimeFileUrl(relativePaths: readonly string[]): Promise<URL> {
  let missingFileError: NodeJS.ErrnoException | null = null;

  for (const relativePath of relativePaths) {
    const candidateUrl = new URL(relativePath, import.meta.url);
    try {
      await fs.stat(fileURLToPath(candidateUrl));
      return candidateUrl;
    } catch (error) {
      if (isMissingFileError(error)) {
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

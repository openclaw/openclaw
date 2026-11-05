import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

const VIEWER_LOADER_PATH = "/plugins/diffs/assets/viewer.js";
const LANGUAGE_PACK_VIEWER_LOADER_PATH = "/plugins/diffs-language-pack/assets/viewer.js";
const BUILT_RUNTIME_PATH = fileURLToPath(new URL("./assets/viewer-runtime.js", import.meta.url));
const SOURCE_RUNTIME_PATH = fileURLToPath(new URL("../assets/viewer-runtime.js", import.meta.url));
const ROOT_BUNDLE_RUNTIME_PATH = fileURLToPath(
  new URL("./extensions/diffs/assets/viewer-runtime.js", import.meta.url),
);
const ROOT_BUNDLE_LANGUAGE_PACK_RUNTIME_PATH = fileURLToPath(
  new URL("./extensions/diffs-language-pack/assets/viewer-runtime.js", import.meta.url),
);

function missingFile(path: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`missing: ${path}`), { code: "ENOENT" });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("viewer runtime resolution", () => {
  it.each([
    {
      name: "prefers the built plugin asset layout when present",
      available: [BUILT_RUNTIME_PATH, SOURCE_RUNTIME_PATH, ROOT_BUNDLE_RUNTIME_PATH],
      languagePack: false,
    },
    {
      name: "falls back to the source asset layout when the built artifact is absent",
      available: [SOURCE_RUNTIME_PATH, ROOT_BUNDLE_RUNTIME_PATH],
      languagePack: false,
    },
    {
      name: "serves the runtime from the unified root bundle layout",
      available: [ROOT_BUNDLE_RUNTIME_PATH],
      languagePack: false,
    },
    {
      name: "serves the language pack from the unified root bundle layout",
      available: [ROOT_BUNDLE_LANGUAGE_PACK_RUNTIME_PATH],
      languagePack: true,
    },
  ])("$name", async ({ available, languagePack }) => {
    vi.spyOn(fs, "readFile").mockImplementation(async (file) => {
      const candidate = file instanceof URL ? fileURLToPath(file) : file;
      if (typeof candidate !== "string") {
        throw new Error("Expected a viewer asset path");
      }
      const index = available.indexOf(candidate);
      if (index < 0) {
        throw missingFile(candidate);
      }
      return Buffer.from(`window.openclawDiffsReady = ${index};\n`);
    });
    const { getServedViewerAsset, getServedLanguagePackViewerAsset } =
      await import("./viewer-assets.js");
    const getAsset = languagePack ? getServedLanguagePackViewerAsset : getServedViewerAsset;
    const loaderPath = languagePack ? LANGUAGE_PACK_VIEWER_LOADER_PATH : VIEWER_LOADER_PATH;
    const loader = await getAsset(loaderPath);
    const runtime = await getAsset(loaderPath.replace("viewer.js", "viewer-runtime.js"));
    expect(loader?.contentType).toBe("text/javascript; charset=utf-8");
    expect(String(loader?.body)).toMatch(/^import "\.\/viewer-runtime\.js\?v=[a-f0-9]{12}";\n$/);
    expect(runtime?.contentType).toBe("text/javascript; charset=utf-8");
    expect(runtime?.body).toEqual(Buffer.from("window.openclawDiffsReady = 0;\n"));
  });

  it("treats only the missing language pack as optional", async () => {
    vi.spyOn(fs, "readFile").mockRejectedValue(missingFile("packaged runtime"));
    const { getServedViewerAsset, getServedLanguagePackViewerAsset } =
      await import("./viewer-assets.js");
    await expect(getServedViewerAsset(VIEWER_LOADER_PATH)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      getServedLanguagePackViewerAsset(LANGUAGE_PACK_VIEWER_LOADER_PATH),
    ).resolves.toBeNull();
  });
});

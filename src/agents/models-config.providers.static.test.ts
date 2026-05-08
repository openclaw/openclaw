import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type StaticModule = typeof import("./models-config.providers.static.js");

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "openclaw-provider-catalogs-"));
const fixtureExtensionsDir = path.join(fixtureRoot, "dist-runtime", "extensions");

function writeFixtureCatalog(dirName: string, exportNames: string[]) {
  const pluginDir = path.join(fixtureExtensionsDir, dirName);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "provider-catalog.js"),
    exportNames
      .map((exportName) => `export function ${exportName}() { return "${dirName}"; }`)
      .join("\n") + "\n",
    "utf8",
  );
}

writeFixtureCatalog("openrouter", ["buildOpenrouterProvider"]);
writeFixtureCatalog("volcengine", ["buildDoubaoProvider", "buildDoubaoCodingProvider"]);

let staticModule: StaticModule;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock("../plugins/bundled-plugin-metadata.js", () => ({
    listBundledPluginMetadata: (_params: { rootDir: string }) => [
      {
        dirName: "openrouter",
        publicSurfaceArtifacts: ["provider-catalog.js"],
        manifest: { id: "openrouter", providers: ["openrouter"] },
      },
      {
        dirName: "volcengine",
        publicSurfaceArtifacts: ["provider-catalog.js"],
        manifest: { id: "volcengine", providers: ["volcengine", "byteplus"] },
      },
      {
        dirName: "ignored",
        publicSurfaceArtifacts: ["api.js"],
        manifest: { id: "ignored", providers: [] },
      },
    ],
    resolveBundledPluginPublicSurfacePath: ({
      rootDir,
      dirName,
      artifactBasename,
    }: {
      rootDir: string;
      dirName: string;
      artifactBasename: string;
    }) => path.join(rootDir, "dist-runtime", "extensions", dirName, artifactBasename),
  }));
  staticModule = await import("./models-config.providers.static.js");
});

afterAll(() => {
  vi.doUnmock("../plugins/bundled-plugin-metadata.js");
  vi.resetModules();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("models-config bundled provider catalogs", () => {
  it("detects provider catalogs from plugin folders via metadata artifacts", () => {
    const entries = staticModule.resolveBundledProviderCatalogEntries({ rootDir: fixtureRoot });
    expect(entries.map((entry) => entry.dirName)).toEqual(["openrouter", "volcengine"]);
    expect(entries.find((entry) => entry.dirName === "volcengine")).toMatchObject({
      dirName: "volcengine",
      pluginId: "volcengine",
    });
  });

  it("loads provider catalog exports from detected plugin folders", async () => {
    const exports = await staticModule.loadBundledProviderCatalogExportMap({
      rootDir: fixtureRoot,
    });
    expect(exports.buildOpenrouterProvider).toBeTypeOf("function");
    expect(exports.buildDoubaoProvider).toBeTypeOf("function");
    expect(exports.buildDoubaoCodingProvider).toBeTypeOf("function");
  });
});

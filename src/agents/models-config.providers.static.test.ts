import fs from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BundledPluginMetadata } from "../plugins/bundled-plugin-metadata.js";
import {
  loadBundledProviderCatalogExportMap,
  resolveBundledProviderCatalogEntries,
} from "./models-config.providers.static.js";

const fixtureRoot = mkdtempSync(path.join(tmpdir(), "openclaw-provider-catalogs-"));
const fixtureExtensionsDir = path.join(fixtureRoot, "dist-runtime", "extensions");
const fixtureDeps = {
  listBundledPluginMetadata: (_params?: {
    rootDir?: string;
    includeChannelConfigs?: boolean;
    includeSyntheticChannelConfigs?: boolean;
  }): BundledPluginMetadata[] => [
    {
      dirName: "openrouter",
      idHint: "openrouter",
      source: { source: "src/index.ts", built: "dist/index.js" },
      publicSurfaceArtifacts: ["provider-catalog.js"],
      manifest: { id: "openrouter", configSchema: {}, providers: ["openrouter"] },
    },
    {
      dirName: "volcengine",
      idHint: "volcengine",
      source: { source: "src/index.ts", built: "dist/index.js" },
      publicSurfaceArtifacts: ["provider-catalog.js"],
      manifest: { id: "volcengine", configSchema: {}, providers: ["volcengine", "byteplus"] },
    },
    {
      dirName: "ignored",
      idHint: "ignored",
      source: { source: "src/index.ts", built: "dist/index.js" },
      publicSurfaceArtifacts: ["api.js"],
      manifest: { id: "ignored", configSchema: {}, providers: [] },
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
};

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

afterAll(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("models-config bundled provider catalogs", () => {
  it("detects provider catalogs from plugin folders via metadata artifacts", () => {
    const entries = resolveBundledProviderCatalogEntries({
      rootDir: fixtureRoot,
      deps: fixtureDeps,
    });
    expect(entries.map((entry) => entry.dirName)).toEqual(["openrouter", "volcengine"]);
    expect(entries.find((entry) => entry.dirName === "volcengine")).toMatchObject({
      dirName: "volcengine",
      pluginId: "volcengine",
    });
  });

  it("loads provider catalog exports from detected plugin folders", async () => {
    const exports = await loadBundledProviderCatalogExportMap({
      rootDir: fixtureRoot,
      deps: fixtureDeps,
    });
    expect(exports.buildOpenrouterProvider).toBeTypeOf("function");
    expect(exports.buildDoubaoProvider).toBeTypeOf("function");
    expect(exports.buildDoubaoCodingProvider).toBeTypeOf("function");
  });
});

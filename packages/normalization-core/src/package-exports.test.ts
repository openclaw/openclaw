import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildPackageDistEntriesFromExports } from "../../../scripts/lib/workspace-package-entries.mts";

type PackageManifest = {
  exports: Record<
    string,
    {
      default: string;
      import: string;
      types: string;
    }
  >;
  scripts: { build: string };
};

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const manifest = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageManifest;

describe("normalization-core package exports", () => {
  it("builds every focused export from its matching source entry", () => {
    const entries = buildPackageDistEntriesFromExports("normalization-core");
    expect(manifest.scripts.build.split(/\s+/u).slice(-2)).toEqual([
      "../../scripts/build-workspace-package.mts",
      "normalization-core",
    ]);
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const entryName = subpath === "." ? "index" : subpath.slice(2);
      expect(target).toEqual({
        types: `./dist/${entryName}.d.mts`,
        import: `./dist/${entryName}.mjs`,
        default: `./dist/${entryName}.mjs`,
      });
      const source = `packages/normalization-core/src/${entryName}.ts`;
      expect(entries[entryName]).toBe(source);
      expect(fs.existsSync(source)).toBe(true);
    }
  });
});

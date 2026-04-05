import fs from "node:fs";
import { describe, expect, it } from "vitest";

type DiffsPackageManifest = {
  dependencies?: Record<string, string>;
  mullusi?: {
    bundle?: {
      stageRuntimeDependencies?: boolean;
    };
  };
};

describe("diffs package manifest", () => {
  it("opts into staging bundled runtime dependencies", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as DiffsPackageManifest;

    expect(packageJson.dependencies?.["@pierre/diffs"]).toBeDefined();
    expect(packageJson.mullusi?.bundle?.stageRuntimeDependencies).toBe(true);
  });
});

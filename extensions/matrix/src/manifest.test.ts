import fs from "node:fs";
import { describe, expect, it } from "vitest";

type MatrixPackageManifest = {
  dependencies?: Record<string, string>;
};

describe("matrix package manifest", () => {
  it("keeps runtime dependencies in the package manifest", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as MatrixPackageManifest;

    expect(packageJson.dependencies?.["fake-indexeddb"]).toBeDefined();
  });
});

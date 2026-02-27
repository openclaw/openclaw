import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("memory-lancedb packaging dependencies", () => {
  it("declares runtime deps at repo root so npm global installs include them", () => {
    const rootPackageJsonPath = path.resolve(__dirname, "..", "..", "package.json");
    const rootPackageJson = JSON.parse(fs.readFileSync(rootPackageJsonPath, "utf8")) as {
      dependencies?: Record<string, string>;
    };

    expect(rootPackageJson.dependencies?.["@lancedb/lancedb"]).toBeTruthy();
    expect(rootPackageJson.dependencies?.openai).toBeTruthy();
  });
});

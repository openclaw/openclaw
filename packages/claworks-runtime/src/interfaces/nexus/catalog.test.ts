import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { listPackages, scanNexusCatalog } from "./catalog.js";

describe("nexus catalog", () => {
  it("scans pack directories", async () => {
    const dir = await mkdtemp(join(tmpdir(), "nexus-catalog-"));
    const packDir = join(dir, "demo-pack");
    await mkdir(join(packDir, "ontology", "playbooks"), { recursive: true });
    await writeFile(
      join(packDir, "claworks.pack.json"),
      JSON.stringify({
        id: "demo-pack",
        name: "Demo",
        version: "1.0.0",
        license: "MIT",
        provides: { objectTypes: [], playbooks: [], actionTypes: [] },
      }),
      "utf8",
    );

    const entries = await scanNexusCatalog(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.slug).toBe("demo-pack");

    const listed = listPackages(entries, { family: "claworks-pack", q: "demo" });
    expect(listed[0]?.latestVersion).toBe("1.0.0");
  });
});

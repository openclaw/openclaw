import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { packStrategy } from "./strategy-packer.js";

describe("packStrategy", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "pack-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("produces a valid ZIP buffer", async () => {
    const stratDir = join(tmpDir, "my-strat");
    await mkdir(join(stratDir, "scripts"), { recursive: true });
    await writeFile(join(stratDir, "fep.yaml"), "name: test\n");
    await writeFile(join(stratDir, "scripts", "strategy.py"), "class S:\n  pass\n");

    const buf = await packStrategy(stratDir);

    // ZIP magic bytes: PK (0x50 0x4b)
    expect(buf[0]).toBe(0x50);
    expect(buf[1]).toBe(0x4b);
    expect(buf.length).toBeGreaterThan(0);
  });

  it("archive contains the expected files", async () => {
    const stratDir = join(tmpDir, "momentum_v1");
    await mkdir(join(stratDir, "scripts"), { recursive: true });
    await writeFile(join(stratDir, "fep.yaml"), "section_a:\n  name: test\n");
    await writeFile(join(stratDir, "scripts", "strategy.py"), "class TestStrategy:\n  pass\n");

    const buf = await packStrategy(stratDir);

    // Parse ZIP and verify contents
    const zip = await JSZip.loadAsync(buf);
    const files = Object.keys(zip.files).filter((f) => !zip.files[f].dir);

    expect(files).toContain("momentum_v1/fep.yaml");
    expect(files).toContain("momentum_v1/scripts/strategy.py");

    // Verify file content
    const fepContent = await zip.file("momentum_v1/fep.yaml")!.async("string");
    expect(fepContent).toContain("section_a:");
  });

  it("throws for non-existent path", async () => {
    await expect(packStrategy("/nonexistent/path")).rejects.toThrow();
  });

  it("throws for file path (not directory)", async () => {
    const filePath = join(tmpDir, "not-a-dir.txt");
    await writeFile(filePath, "hello");
    await expect(packStrategy(filePath)).rejects.toThrow("Not a directory");
  });
});

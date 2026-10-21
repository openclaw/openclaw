import fs from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeMeetExportBundle } from "./cli-export.js";

const writeBundle = (outputDir: string, zip = false) =>
  writeMeetExportBundle({
    outputDir,
    artifacts: { conferenceRecords: [], artifacts: [] },
    attendance: { conferenceRecords: [], attendance: [] },
    zip,
  });

describe("Google Meet export publication", () => {
  let tempDir: string;
  let outputDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-export-publication-"));
    outputDir = path.join(tempDir, "bundle");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps an existing bundle member when replacement fails", async () => {
    const summaryPath = path.join(outputDir, "summary.md");
    fs.mkdirSync(outputDir);
    fs.writeFileSync(summaryPath, "previous summary\n");
    const priorBytes = fs.readFileSync(summaryPath);

    vi.spyOn(fsp, "writeFile").mockImplementationOnce(async (file) => {
      expect(typeof file).toBe("string");
      fs.writeFileSync(file as string, "partial replacement");
      throw new Error("injected write failure");
    });

    await expect(writeBundle(outputDir)).rejects.toThrow("injected write failure");

    expect(fs.readFileSync(summaryPath)).toEqual(priorBytes);
    expect(fs.readdirSync(outputDir)).toEqual(["summary.md"]);
  });

  it("keeps an existing ZIP when replacement fails", async () => {
    const zipPath = `${outputDir}.zip`;
    const priorZip = await new JSZip()
      .file("previous.txt", "previous export")
      .generateAsync({ type: "nodebuffer" });
    fs.writeFileSync(zipPath, priorZip);
    const realWriteFile = fsp.writeFile;

    vi.spyOn(fsp, "writeFile").mockImplementation(async (...args) => {
      const [file, data] = args;
      if (Buffer.isBuffer(data)) {
        expect(typeof file).toBe("string");
        fs.writeFileSync(file as string, "partial replacement");
        throw new Error("injected ZIP write failure");
      }
      await Reflect.apply(realWriteFile, fsp, args);
    });

    await expect(writeBundle(outputDir, true)).rejects.toThrow("injected ZIP write failure");

    expect(fs.readFileSync(zipPath)).toEqual(priorZip);
    expect(fs.readdirSync(tempDir).toSorted()).toEqual(["bundle", "bundle.zip"]);
  });

  it.each([
    { label: "repeated native", trailingSeparators: path.sep.repeat(2) },
    ...(process.platform === "win32"
      ? [
          { label: "repeated alternate", trailingSeparators: "//" },
          { label: "mixed", trailingSeparators: "\\/" },
        ]
      : []),
  ])(
    "writes the ZIP beside an output directory with $label trailing separators",
    async ({ trailingSeparators }) => {
      const suppliedOutputDir = `${outputDir}${trailingSeparators}`;
      const zipPath = `${outputDir}.zip`;
      const result = await writeBundle(suppliedOutputDir, true);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(outputDir, "manifest.json"), "utf8"),
      ) as {
        zipFile?: string;
      };
      expect(result).toMatchObject({ outputDir: suppliedOutputDir, zipFile: zipPath });
      expect(manifest.zipFile).toBe(zipPath);
      expect(fs.existsSync(zipPath)).toBe(true);
      expect(fs.existsSync(path.join(outputDir, ".zip"))).toBe(false);
    },
  );
});

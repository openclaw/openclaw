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

  it.each([false, true])(
    "preserves the existing file on failed replacement (zip=%s)",
    async (zip) => {
      const filePath = zip ? `${outputDir}.zip` : path.join(outputDir, "summary.md");
      const previous = zip
        ? await new JSZip()
            .file("previous.txt", "previous export")
            .generateAsync({ type: "nodebuffer" })
        : Buffer.from("previous summary\n");
      if (!zip) {
        fs.mkdirSync(outputDir);
      }
      fs.writeFileSync(filePath, previous);
      const realWriteFile = fsp.writeFile;
      const write = vi.spyOn(fsp, "writeFile");
      write[zip ? "mockImplementation" : "mockImplementationOnce"](async (...args) => {
        const [file, data] = args;
        if (!zip || Buffer.isBuffer(data)) {
          expect(typeof file).toBe("string");
          fs.writeFileSync(file as string, "partial replacement");
          throw new Error("injected write failure");
        }
        await Reflect.apply(realWriteFile, fsp, args);
      });
      await expect(writeBundle(outputDir, zip)).rejects.toThrow("injected write failure");
      expect(fs.readFileSync(filePath)).toEqual(previous);
      expect(fs.readdirSync(zip ? tempDir : outputDir).toSorted()).toEqual(
        zip ? ["bundle", "bundle.zip"] : ["summary.md"],
      );
    },
  );

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

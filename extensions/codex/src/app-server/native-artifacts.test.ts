import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendCodexNativeArtifactsToResult,
  collectNewCodexNativeArtifacts,
  snapshotCodexNativeArtifacts,
} from "./native-artifacts.js";

let tempDir: string;

describe("Codex native artifact collection", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-artifacts-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("collects new generated documents and images after the turn snapshot", async () => {
    const codexHome = path.join(tempDir, "codex-home");
    const preexisting = path.join(codexHome, "generated_images", "old.png");
    await fs.mkdir(path.dirname(preexisting), { recursive: true });
    await fs.writeFile(preexisting, "old image");

    const snapshot = await snapshotCodexNativeArtifacts(codexHome);

    const generatedPdf = path.join(codexHome, "generated_documents", "report.pdf");
    const generatedSheet = path.join(codexHome, "generated_files", "report.xlsx");
    await fs.mkdir(path.dirname(generatedPdf), { recursive: true });
    await fs.mkdir(path.dirname(generatedSheet), { recursive: true });
    await fs.writeFile(generatedPdf, "pdf bytes");
    await fs.writeFile(generatedSheet, "xlsx bytes");

    await expect(collectNewCodexNativeArtifacts(snapshot)).resolves.toEqual([
      generatedPdf,
      generatedSheet,
    ]);
  });

  it("treats generated-artifact directory read failures as non-fatal", async () => {
    const codexHome = path.join(tempDir, "codex-home");
    const generatedFile = path.join(codexHome, "generated_files", "report.pdf");
    await fs.mkdir(path.dirname(generatedFile), { recursive: true });
    await fs.writeFile(generatedFile, "pdf bytes");

    const originalReadDir = fs.readdir.bind(fs) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(fs, "readdir").mockImplementation(async (...args: unknown[]) => {
      const [dir] = args;
      if (String(dir).endsWith("generated_images")) {
        throw Object.assign(new Error("locked directory"), { code: "EPERM" });
      }
      return (await originalReadDir(...args)) as never;
    }) as never;

    const snapshot = await snapshotCodexNativeArtifacts(codexHome);

    expect(snapshot.files.has(generatedFile)).toBe(true);
  });

  it("adds generated artifacts to tool media unless delivery was already explicit", () => {
    expect(
      appendCodexNativeArtifactsToResult({ assistantTexts: [], toolMediaUrls: ["/tmp/a.png"] }, [
        "/tmp/a.png",
        "/tmp/b.docx",
      ]),
    ).toMatchObject({
      assistantTexts: ["Generated document attached."],
      toolMediaUrls: ["/tmp/a.png", "/tmp/b.docx"],
    });

    expect(
      appendCodexNativeArtifactsToResult({ assistantTexts: ["Done."], toolMediaUrls: [] }, [
        "/tmp/a.png",
      ]),
    ).toMatchObject({
      assistantTexts: ["Done."],
      toolMediaUrls: ["/tmp/a.png"],
    });

    expect(
      appendCodexNativeArtifactsToResult(
        {
          assistantTexts: ["caption\nMEDIA:/tmp/explicit.png"],
          toolMediaUrls: [],
        },
        ["/tmp/native.png"],
      ).toolMediaUrls,
    ).toEqual([]);

    expect(
      appendCodexNativeArtifactsToResult(
        {
          assistantTexts: [],
          messagingToolSentMediaUrls: ["/tmp/sent.png"],
          toolMediaUrls: [],
        },
        ["/tmp/native.png"],
      ).toolMediaUrls,
    ).toEqual([]);
  });
});

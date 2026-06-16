/**
 * Tests for tool file path extension validation.
 * Catches model-side hallucination patterns like .docx → .docodex.
 */
import { describe, expect, it } from "vitest";
import { validateToolFilePathExtension } from "./agent-tools.read.js";

describe("validateToolFilePathExtension", () => {
  it("allows valid .docx paths", () => {
    expect(() => validateToolFilePathExtension("/path/to/report.docx")).not.toThrow();
    expect(() => validateToolFilePathExtension("report.docx")).not.toThrow();
  });

  it("allows paths with no extension", () => {
    expect(() => validateToolFilePathExtension("/path/to/README")).not.toThrow();
    expect(() => validateToolFilePathExtension("Makefile")).not.toThrow();
  });

  it("rejects .docodex hallucination", () => {
    expect(() => validateToolFilePathExtension("/path/to/file.docodex")).toThrow(
      /Suspicious file extension/,
    );
    expect(() => validateToolFilePathExtension("file.docodex")).toThrow(
      /Suspicious file extension/,
    );
  });

  it("includes suggestion when cleaned extension matches known extension", () => {
    // Removing "odex" from "docodex" yields ".doc" which is known.
    expect(() => validateToolFilePathExtension("file.docodex")).toThrow(
      /did you mean.*\.doc/,
    );
  });

  it("rejects .docxcodex double extension", () => {
    expect(() => validateToolFilePathExtension("file.docxcodex")).toThrow(
      /Suspicious file extension/,
    );
  });

  it("rejects .pptcodex pattern", () => {
    expect(() => validateToolFilePathExtension("slides.pptcodex")).toThrow(
      /Suspicious file extension/,
    );
  });

  it("rejects .xlscodex pattern", () => {
    expect(() => validateToolFilePathExtension("data.xlscodex")).toThrow(
      /Suspicious file extension/,
    );
  });

  it("allows various known extensions", () => {
    const knownExtensions = [
      "main.ts",
      "main.tsx",
      "main.js",
      "main.jsx",
      "main.py",
      "main.go",
      "main.rs",
      "main.java",
      "main.c",
      "main.cpp",
      "main.sh",
      "main.bash",
      "Dockerfile",
      "config.json",
      "config.yaml",
      "config.yml",
      "config.toml",
      "data.csv",
      "data.xml",
      "data.html",
      "page.md",
      "archive.zip",
      "archive.tar.gz",
      "image.png",
      "image.jpg",
      "image.jpeg",
      "image.webp",
      "image.gif",
      "image.heic",
      "audio.mp3",
      "audio.wav",
      "audio.ogg",
      "audio.flac",
      "video.mp4",
      "video.mov",
      "video.avi",
      "doc.pdf",
      "spreadsheet.xlsx",
      "presentation.pptx",
    ];
    for (const filename of knownExtensions) {
      expect(() => validateToolFilePathExtension(filename)).not.toThrow();
    }
  });
});

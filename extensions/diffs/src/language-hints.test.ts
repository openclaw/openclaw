// Diffs tests cover language hints plugin behavior.
import type { FileDiffMetadata } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import {
  normalizeDiffViewerPayloadLanguages,
  normalizeSupportedLanguageHint,
} from "./language-hints.js";
import type { DiffViewerOptions } from "./types.js";

const viewerOptions: DiffViewerOptions = {
  theme: {
    light: "pierre-light",
    dark: "pierre-dark",
  },
  diffStyle: "unified",
  diffIndicators: "bars",
  disableLineNumbers: false,
  expandUnchanged: false,
  themeType: "dark",
  backgroundEnabled: true,
  overflow: "wrap",
  unsafeCSS: "",
};

async function normalizeHints(values: readonly string[]) {
  return await Promise.all(values.map((value) => normalizeSupportedLanguageHint(value)));
}

describe("normalizeSupportedLanguageHint", () => {
  it("normalizes common aliases to base viewer languages", async () => {
    await expect(
      normalizeHints(["ts", "c++", "c#", "bash", "dockerfile", "rb", "kt", "ps1"]),
    ).resolves.toEqual([
      "typescript",
      "cpp",
      "csharp",
      "sh",
      "docker",
      "ruby",
      "kotlin",
      "powershell",
    ]);
  });
});

describe("normalizeDiffViewerPayloadLanguages", () => {
  it("rewrites stale patch payload language overrides to plain text", async () => {
    const result = await normalizeDiffViewerPayloadLanguages({
      prerenderedHTML: "<div>diff</div>",
      options: viewerOptions,
      langs: ["not-a-real-language" as never],
      fileDiff: {
        name: "foo.txt",
        lang: "not-a-real-language" as never,
      } as unknown as FileDiffMetadata,
    });

    expect(result.langs).toEqual(["text"]);
    expect(result.fileDiff?.lang).toBe("text");
  });

  it("rewrites blank explicit language overrides to plain text", async () => {
    const result = await normalizeDiffViewerPayloadLanguages({
      prerenderedHTML: "<div>diff</div>",
      options: viewerOptions,
      langs: ["   " as never],
      oldFile: {
        name: "before.unknown",
        contents: "before",
        lang: "   " as never,
      },
      newFile: {
        name: "after.txt",
        contents: "after",
      },
    });

    expect(result.langs).toEqual(["text"]);
    expect(result.oldFile?.lang).toBe("text");
  });
});

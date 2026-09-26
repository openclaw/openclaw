import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestMemoryWikiSource } from "./ingest.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
const EMPTY_NOTES = "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->";

async function createSourceFixture(filename: string, content = "first body\n") {
  const rootDir = await createTempDir("memory-wiki-notes-");
  const inputPath = path.join(rootDir, filename);
  const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
  await fs.writeFile(inputPath, content, "utf8");
  await ingestMemoryWikiSource({
    config,
    inputPath,
    nowMs: Date.UTC(2026, 3, 5, 12, 0, 0),
  });
  const pagePath = path.join(config.vault.path, "sources", `${path.parse(filename).name}.md`);

  return {
    pagePath,
    editNotes: async (note: string, crlf = false) => {
      const edited = (await fs.readFile(pagePath, "utf8")).replace(
        EMPTY_NOTES,
        `<!-- openclaw:human:start -->\n${note}\n<!-- openclaw:human:end -->`,
      );
      await fs.writeFile(pagePath, crlf ? edited.replace(/\n/g, "\r\n") : edited, "utf8");
    },
    reingest: async (updatedContent: string) => {
      await fs.writeFile(inputPath, updatedContent, "utf8");
      await ingestMemoryWikiSource({
        config,
        inputPath,
        nowMs: Date.UTC(2026, 3, 6, 12, 0, 0),
      });
      return fs.readFile(pagePath, "utf8");
    },
  };
}

describe("ingestMemoryWikiSource human notes", () => {
  it("preserves user notes when the same source is re-ingested", async () => {
    const { editNotes, reingest } = await createSourceFixture("roadmap.txt", "v1 content\n");
    const userNote = "KEY INSIGHT: covers $1 of the Q2 roadmap";
    await editNotes(userNote);

    const after = await reingest("v2 content updated\n");
    expect(after).toContain("v2 content updated");
    expect(after).toContain(userNote);
  });

  it.each([
    {
      name: "closing",
      malformedNotes: "<!-- openclaw:human:start -->\nHANDWRITTEN NOTE MUST SURVIVE",
      missingMarker: /openclaw:human:end/i,
    },
    {
      name: "opening",
      malformedNotes: "HANDWRITTEN NOTE MUST SURVIVE\n<!-- openclaw:human:end -->",
      missingMarker: /openclaw:human:start/i,
    },
    {
      name: "opening and closing",
      malformedNotes: "HANDWRITTEN NOTE MUST SURVIVE",
      missingMarker: /openclaw:human:start/i,
    },
  ])(
    "preserves the source page when handwritten Notes are missing the $name marker",
    async ({ malformedNotes, missingMarker }) => {
      const { pagePath, reingest } = await createSourceFixture(
        "roadmap.txt",
        "original source content\n",
      );
      const existingPage = (await fs.readFile(pagePath, "utf8")).replace(
        EMPTY_NOTES,
        malformedNotes,
      );
      await fs.writeFile(pagePath, existingPage, "utf8");

      await expect(reingest("updated source content\n")).rejects.toThrow(missingMarker);
      await expect(fs.readFile(pagePath, "utf8")).resolves.toBe(existingPage);
    },
  );

  it("preserves notes without corrupting source content that contains human markers", async () => {
    const { editNotes, reingest } = await createSourceFixture("notes.txt");
    const userNote = "MY PRIVATE NOTE";
    await editNotes(userNote);

    const sourceWithMarkers = [
      "second body",
      "<!-- openclaw:human:start -->",
      "INJECTED FROM SOURCE",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n");
    const after = await reingest(sourceWithMarkers);
    const notesBlock = after.slice(after.indexOf("## Notes"));
    expect(after).toContain("INJECTED FROM SOURCE");
    expect(notesBlock).toContain(userNote);
    expect(notesBlock).not.toContain("INJECTED FROM SOURCE");
  });

  it("preserves CRLF notes without copying marker comments from existing source content", async () => {
    const sourceWithMarkers = [
      "first body",
      "<!-- openclaw:human:start -->",
      "OLD SOURCE MARKER PAYLOAD",
      "<!-- openclaw:human:end -->",
      "",
    ].join("\n");
    const { editNotes, reingest } = await createSourceFixture(
      "windows-notes.txt",
      sourceWithMarkers,
    );
    const userNote = "CRLF USER NOTE";
    await editNotes(userNote, true);

    const after = await reingest("second body without marker comments\n");
    const notesBlock = after.slice(after.indexOf("## Notes"));
    expect(after).toContain("second body without marker comments");
    expect(notesBlock).toContain(userNote);
    expect(notesBlock).not.toContain("OLD SOURCE MARKER PAYLOAD");
  });

  it("preserves the whole note when the note text itself contains a marker comment", async () => {
    const { editNotes, reingest } = await createSourceFixture("diary.txt");
    const noteWithMarker = [
      "EARLY NOTE before any quoted marker",
      "<!-- openclaw:human:start -->",
      "LATE NOTE after a pasted marker",
    ].join("\n");
    await editNotes(noteWithMarker);

    const after = await reingest("second body\n");
    expect(after).toContain("second body");
    expect(after).toContain("EARLY NOTE before any quoted marker");
    expect(after).toContain("LATE NOTE after a pasted marker");
  });

  it("preserves the note when the note text contains a Markdown heading", async () => {
    const { editNotes, reingest } = await createSourceFixture("log.txt");
    const noteWithHeading = ["NOTE TOP", "## Notes", "NOTE BOTTOM under a pasted heading"].join(
      "\n",
    );
    await editNotes(noteWithHeading);

    const after = await reingest("second body\n");
    expect(after).toContain("second body");
    expect(after).toContain("NOTE TOP");
    expect(after).toContain("NOTE BOTTOM under a pasted heading");
  });
});

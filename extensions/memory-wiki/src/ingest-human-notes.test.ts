import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ingestMemoryWikiSource } from "./ingest.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();
const START = "<!-- openclaw:human:start -->";
const END = "<!-- openclaw:human:end -->";
const EMPTY_NOTES = `${START}\n${END}`;

async function createSourceFixture(content = "first body\n") {
  const rootDir = await createTempDir("memory-wiki-notes-");
  const inputPath = path.join(rootDir, "notes.txt");
  const { config } = await createVault({ rootDir: path.join(rootDir, "vault") });
  await fs.writeFile(inputPath, content, "utf8");
  const ingest = (day: number) =>
    ingestMemoryWikiSource({ config, inputPath, nowMs: Date.UTC(2026, 3, day, 12) });
  await ingest(5);
  const pagePath = path.join(config.vault.path, "sources/notes.md");
  const read = () => fs.readFile(pagePath, "utf8");
  const edit = async (notes: string, crlf = false) => {
    const edited = (await read()).replace(EMPTY_NOTES, notes);
    await fs.writeFile(pagePath, crlf ? edited.replace(/\n/g, "\r\n") : edited, "utf8");
    return edited;
  };
  return {
    read,
    edit,
    editNotes: (note: string, crlf = false) => edit(`${START}\n${note}\n${END}`, crlf),
    reingest: async (updatedContent: string) => {
      await fs.writeFile(inputPath, updatedContent, "utf8");
      await ingest(6);
      return read();
    },
  };
}

describe("ingestMemoryWikiSource human notes", () => {
  it("preserves user notes when the same source is re-ingested", async () => {
    const { editNotes, reingest } = await createSourceFixture("v1 content\n");
    const userNote = "KEY INSIGHT: covers $1 of the Q2 roadmap";
    await editNotes(userNote);

    const after = await reingest("v2 content updated\n");
    expect(after).toContain("v2 content updated");
    expect(after).toContain(userNote);
  });

  it.each([
    ["closing", `${START}\nHANDWRITTEN NOTE MUST SURVIVE`, /openclaw:human:end/i],
    ["opening", `HANDWRITTEN NOTE MUST SURVIVE\n${END}`, /openclaw:human:start/i],
    ["opening and closing", "HANDWRITTEN NOTE MUST SURVIVE", /openclaw:human:start/i],
  ] as const)(
    "preserves the source page when handwritten Notes are missing the %s marker",
    async (_name, malformedNotes, missingMarker) => {
      const { edit, read, reingest } = await createSourceFixture("original source content\n");
      const existingPage = await edit(malformedNotes);

      await expect(reingest("updated source content\n")).rejects.toThrow(missingMarker);
      await expect(read()).resolves.toBe(existingPage);
    },
  );

  it("preserves CRLF notes without copying marker comments from existing source content", async () => {
    const { editNotes, reingest } = await createSourceFixture(
      `first body\n${START}\nOLD SOURCE MARKER PAYLOAD\n${END}\n`,
    );
    const userNote = "CRLF USER NOTE";
    await editNotes(userNote, true);

    const after = await reingest("second body without marker comments\n");
    const notesBlock = after.slice(after.indexOf("## Notes"));
    expect(after).toContain("second body without marker comments");
    expect(notesBlock).toContain(userNote);
    expect(notesBlock).not.toContain("OLD SOURCE MARKER PAYLOAD");
  });
});

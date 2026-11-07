import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const fixture = createManagerIndexFixture(await import("./index.js"));

const marker = "<!-- chunking: entries -->";
const notesPath = "memory/people.md";
const bullets = [
  "- Alice prefers morning standups.",
  "- Alice is allergic to peanuts.",
  "- Alice drives a green Volvo.",
];

function indexedTexts(database: DatabaseSync) {
  return database
    .prepare(
      "SELECT text FROM memory_index_chunks WHERE path = ? AND source = 'memory' ORDER BY start_line",
    )
    .all(notesPath)
    .map((row) => String(row.text));
}

it("reindexes a topic file when the per-entry marker is added and removed", async () => {
  const file = path.join(fixture.paths.workspace, notesPath);
  const write = (lines: string[], mtimeMs: number) =>
    fs
      .writeFile(file, lines.join("\n"))
      .then(() => fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000));
  await write(["# Alice", ...bullets], 1_700_000_000_000);
  const manager = await fixture.getFreshManager(
    fixture.createConfig({ sources: ["memory"], provider: "none", vectorEnabled: false }),
  );
  const database = Reflect.get(manager, "db") as DatabaseSync;
  const resync = async (reason: string) => {
    Reflect.set(manager, "dirty", true);
    await manager.sync({ reason });
  };
  await manager.sync({ reason: "initial", force: true });
  const sized = indexedTexts(database);
  expect(sized).toEqual([["# Alice", ...bullets].join("\n")]);

  await write([marker, "# Alice", ...bullets], 1_700_000_100_000);
  await resync("marker-added");
  expect(indexedTexts(database)).toEqual([`# Alice\n${bullets[0]}`, bullets[1], bullets[2]]);

  await write(["# Alice", ...bullets], 1_700_000_200_000);
  await resync("marker-removed");
  expect(indexedTexts(database)).toEqual(sized);
});

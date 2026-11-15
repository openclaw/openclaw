import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import * as transfer from "./manager-publication-transfer.js";

const fixture = createManagerIndexFixture(await import("./index.js"));
afterEach(() => vi.restoreAllMocks());

// Escaped control characters exceed the group byte budget without hitting its row limit.
const budgetText = (index: number) =>
  Array.from({ length: 200 }, (_, line) => `Alpha ${index} ${line} ${"\u0001".repeat(120)}`).join(
    "\n",
  );
it.each([
  ["group", 6, (i: number) => `# Group ${i}\nAlpha note ${i}.\nBeta line ${i}.\n`],
  ["budget", 3, budgetText],
  [
    "staged",
    1,
    () =>
      Array.from(
        { length: 30_000 },
        (_, i) => `Alpha memory line ${i} with beta filler text.`,
      ).join("\n"),
  ],
] as const)("prints each row once for %s publication", async (mode, count, content) => {
  for (let index = 0; index < count; index++) {
    await fs.writeFile(path.join(fixture.paths.memory, `${mode}-${index}.md`), content(index));
  }
  const sourceWide = mode !== "staged";
  const manager = await fixture.getFreshManager(
    fixture.createConfig({
      provider: sourceWide ? "batch-wide-test" : "gemini",
      model: "mock-embed",
      batchEnabled: sourceWide,
      sources: ["memory"],
      vectorEnabled: false,
      cacheEnabled: false,
    }),
  );
  const publish = vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource");
  const group = vi.spyOn(transfer, "memoryPublicationGroup");
  // Each JSON-printed vector is one numeric array, regardless of the publication route.
  const stringify = JSON.stringify;
  let coordinates = 0;
  vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: unknown[]) => {
    if (Array.isArray(value) && value.every((item) => typeof item === "number")) {
      coordinates += value.length;
    }
    return (stringify as (...args: unknown[]) => string)(value, ...rest);
  }) as typeof JSON.stringify);
  try {
    await manager.sync({ reason: "print-once", force: true });
  } finally {
    vi.mocked(JSON.stringify).mockRestore();
  }
  const rows = memoryIndexFixtureWriter(manager)
    .prepare("SELECT text FROM memory_index_chunks WHERE source = 'memory'")
    .all() as Array<{ text: string }>;
  expect(coordinates).toBe(rows.length * 4);
  if (mode === "group") {
    expect(publish).toHaveBeenCalledTimes(1);
    const sources = publish.mock.calls[0]?.[0];
    expect(Array.isArray(sources) && sources.length > 1).toBe(true);
  } else if (mode === "budget") {
    expect(group.mock.results.some((result) => result.value === undefined)).toBe(true);
    expect(publish.mock.calls.length).toBeGreaterThan(1);
  } else {
    const staged = rows.filter((row) => row.text.includes("memory line"));
    expect(staged.reduce((bytes, row) => bytes + row.text.length, 0)).toBeGreaterThan(512 * 1024);
  }
});

import fs from "node:fs/promises";
import path from "node:path";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import {
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import * as transfer from "./manager-publication-transfer.js";
import type { MemoryIndexManager } from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

// Matches the fixture provider: one count per token, four dimensions per chunk.
const embedText = (text: string) =>
  ["alpha", "beta", "image", "audio"].map((token) => text.toLowerCase().split(token).length - 1);

describe("memory publication host printing", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());

  // The observable assumes the JSON transfer format: each printed vector is one numeric array.
  async function syncCountingVectorCoordinates(manager: MemoryIndexManager) {
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
      .prepare("SELECT text, embedding FROM memory_index_chunks WHERE source = 'memory'")
      .all() as Array<{ text: string; embedding: Uint8Array }>;
    expect(coordinates).toBe(rows.length * 4);
    for (const row of rows) {
      expect(new Uint8Array(row.embedding)).toEqual(
        new Uint8Array(encodeMemoryEmbedding(embedText(row.text))),
      );
    }
    return rows;
  }

  // Only source-wide batch embedding publishes several files as one group.
  async function createManager(sourceWide = false) {
    return await fixture.getFreshManager(
      fixture.createConfig({
        provider: sourceWide ? "batch-wide-test" : "gemini",
        model: "mock-embed",
        batchEnabled: sourceWide,
        sources: ["memory"],
        vectorEnabled: false,
        cacheEnabled: false,
      }),
    );
  }

  async function writeFiles(count: number, name: string, content: (index: number) => string) {
    for (let index = 0; index < count; index++) {
      await fs.writeFile(path.join(fixture.paths.memory, `${name}-${index}.md`), content(index));
    }
  }

  it("prints each row of a published source group once", async () => {
    await writeFiles(
      6,
      "group",
      (index) => `# Group ${index}\nAlpha note ${index}.\nBeta line ${index}.\n`,
    );
    const manager = await createManager(true);
    const publish = vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource");
    await syncCountingVectorCoordinates(manager);
    expect(publish).toHaveBeenCalledTimes(1);
    const group = publish.mock.calls[0]?.[0];
    expect(Array.isArray(group) && group.length > 1).toBe(true);
  });

  it("prints each row of a source refused by the group byte budget once", async () => {
    // JSON prints each control character as six characters, so a file of 200 lines of 120 of them
    // prints to roughly 300 KiB in the group accounting (two bytes per printed character) across
    // about 20 rows. One file fits an inline command and two files stay far below the row limit
    // but exceed the 512 KiB group budget, which refuses the second file by bytes alone.
    await writeFiles(3, "budget", (index) =>
      Array.from(
        { length: 200 },
        (_, line) => `Alpha ${index} ${line} ${"\u0001".repeat(120)}`,
      ).join("\n"),
    );
    const manager = await createManager(true);
    const publish = vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource");
    const group = vi.spyOn(transfer, "memoryPublicationGroup");
    await syncCountingVectorCoordinates(manager);
    expect(group.mock.results.some((result) => result.value === undefined)).toBe(true);
    expect(publish.mock.calls.length).toBeGreaterThan(1);
  });

  it("prints each row of a staged source once", async () => {
    await fs.writeFile(
      path.join(fixture.paths.memory, "large.md"),
      Array.from(
        { length: 30_000 },
        (_, index) => `Alpha memory line ${index} with beta filler text.`,
      ).join("\n"),
    );
    const manager = await createManager();
    const rows = await syncCountingVectorCoordinates(manager);
    const staged = rows.filter((row) => row.text.includes("memory line"));
    expect(staged.reduce((bytes, row) => bytes + row.text.length, 0)).toBeGreaterThan(512 * 1024);
  });
});

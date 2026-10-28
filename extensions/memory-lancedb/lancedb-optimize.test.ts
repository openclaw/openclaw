import { pathToFileURL } from "node:url";
import { expect, test } from "vitest";
import { MemoryDB } from "./lancedb-store.js";
import { installTmpDirHarness } from "./test-helpers.js";

const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-optimize-" });

test("offline optimization refuses open handles and preserves every agent's memories", async () => {
  // LanceDB 0.40 cannot create tables from file URLs on Windows.
  const writerPath = process.platform === "win32" ? getDbPath() : pathToFileURL(getDbPath()).href;
  const writer = new MemoryDB(writerPath, 2);
  const optimizer = new MemoryDB(getDbPath(), 2);
  try {
    for (let index = 0; index < 2; index++) {
      await writer.store(index % 2 ? "alpha" : "beta", {
        text: `synthetic memory ${index}`,
        vector: [index / 10, 1],
        category: "fact",
        importance: 0.5,
      });
    }
    const before = await writer.list("alpha");
    const otherAgent = await writer.list("beta");
    const search = async () =>
      (await writer.search("alpha", [0.1, 1], 2, 0)).map(({ entry, score }) => ({
        id: entry.id,
        score,
      }));
    const canary = await search();
    await expect(optimizer.optimize()).rejects.toThrow(/in use/);
    await writer.close();
    await expect(optimizer.optimize()).resolves.toEqual({
      before: { rows: 2, fragments: 2 },
      after: { rows: 2, fragments: 1 },
    });
    writer.start();
    await expect(writer.list("alpha")).resolves.toEqual(before);
    await expect(writer.list("beta")).resolves.toEqual(otherAgent);
    await expect(search()).resolves.toEqual(canary);
  } finally {
    await writer.close();
    await optimizer.close();
  }
});

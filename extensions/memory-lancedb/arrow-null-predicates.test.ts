import { spawnSync } from "node:child_process";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { expect, test } from "vitest";
import { installTmpDirHarness } from "./test-helpers.js";

const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-codegen-" });

test("stores and recalls memory without compiling Arrow predicates at runtime", () => {
  const fixture = `
    import assert from "node:assert/strict";
    import { MemoryDB } from ${JSON.stringify(new URL("./lancedb-store.ts", import.meta.url).href)};
    assert.throws(() => new Function("return " + process.pid), EvalError);
    const db = new MemoryDB(process.argv[1], 2);
    try {
      const first = await db.store("alpha", { text: "alpha preference 🦞 café 中文", vector: [1, -0], importance: 0.8, category: "preference" });
      const second = await db.store("beta", { text: "beta fact", vector: [0, 1], importance: 0.5, category: "fact" });
      const rows = await db.search("alpha", [1, 0], 5, 0);
      assert.deepEqual(rows.map(({ entry, score }) => ({ ...entry, vector: [...entry.vector], score })), [
        { ...first, score: 1 },
      ]);
      assert.deepEqual((await db.list("beta")).map((row) => row.text), ["beta fact"]);
      for (const vector of [[], [1], [1, NaN], [1, null], [1, undefined]]) {
        await assert.rejects(db.store("alpha", { text: "invalid vector", vector, importance: 0.5, category: "fact" }), /Vector column contains NaN or null values/);
      }
      assert.deepEqual((await db.list("alpha")).map((row) => row.id), [first.id]);
      // Existing fixed-size serialization truncates overlong vectors; do not change that contract.
      const truncated = await db.store("alpha", { text: "long vector", vector: [1, 0, 7], importance: 0, category: "other" });
      const longRows = await db.search("alpha", [1, 0], 5, 0);
      assert.deepEqual([...longRows.find(({ entry }) => entry.id === truncated.id).entry.vector], [1, 0]);
      assert.equal(await db.delete("beta", first.id), false);
      assert.equal(await db.delete("alpha", truncated.id), true);
      await db.close();
      await assert.rejects(db.list("alpha"), /closed/);
      const reopened = new MemoryDB(process.argv[1], 2);
      try {
        assert.deepEqual((await reopened.list("alpha")).map(({ id, text }) => ({ id, text })), [
          { id: first.id, text: "alpha preference 🦞 café 中文" },
        ]);
        assert.equal(await reopened.delete("alpha", second.id), false);
        assert.equal(await reopened.delete("alpha", first.id), true);
        assert.deepEqual(await reopened.list("alpha"), []);
        assert.deepEqual((await reopened.list("beta")).map((row) => row.id), [second.id]);
      } finally {
        await reopened.close();
      }
    } finally {
      await db.close();
    }
    console.log("MemoryDB codegen-free round trip passed");
  `;
  const result = spawnSync(
    resolveTestNodeExecPath(),
    [
      "--disallow-code-generation-from-strings",
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "--eval",
      fixture,
      getDbPath(),
    ],
    { encoding: "utf8", timeout: 15_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("MemoryDB codegen-free round trip passed");
});

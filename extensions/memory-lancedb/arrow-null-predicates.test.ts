import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveTestNodeExecPath } from "openclaw/plugin-sdk/test-fixtures";
import { expect, test } from "vitest";
import { installTmpDirHarness } from "./test-helpers.js";

const require = createRequire(import.meta.url);
const arrowRoot = path.dirname(require.resolve("apache-arrow"));
const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-codegen-" });

test("stores and recalls memory without compiling Arrow predicates at runtime", () => {
  const fixture = `
    import assert from "node:assert/strict";
    import { createRequire } from "node:module";
    import { MemoryDB } from ${JSON.stringify(new URL("./lancedb-store.ts", import.meta.url).href)};
    const require = createRequire(import.meta.url);
    assert.throws(() => new Function("return " + process.pid), EvalError);
    const modules = [
      [require(${JSON.stringify(path.join(arrowRoot, "Arrow.node.js"))}), require(${JSON.stringify(path.join(arrowRoot, "builder/valid.js"))})],
      [await import(${JSON.stringify(pathToFileURL(path.join(arrowRoot, "Arrow.node.mjs")).href)}), await import(${JSON.stringify(pathToFileURL(path.join(arrowRoot, "builder/valid.mjs")).href)})],
    ];
    for (const [arrow, { createIsValidFunction }] of modules) {
      const text = arrow.vectorFromArray(["first", null, "last"], new arrow.Utf8());
      assert.deepEqual([...text], ["first", null, "last"]);
      const numbers = arrow.makeBuilder({ type: new arrow.Float64(), nullValues: [null, undefined, NaN, -0] });
      for (const value of [1, null, 2, undefined, NaN, 0, -0, 3]) numbers.append(value);
      assert.deepEqual([...numbers.finish().toVector()], [1, null, 2, null, null, null, null, 3]);
      const sentinels = [null, undefined, NaN, 0, 1n, "N/A", 'a"b', "line\\nbreak", "back\\\\slash"];
      const valid = createIsValidFunction(sentinels);
      for (const value of sentinels) assert.equal(valid(value), false);
      for (const value of [false, true, 1, 2n, "0", "ok"]) assert.equal(valid(value), true);
      sentinels.push("later");
      assert.equal(valid("later"), true);
      const nullOnly = createIsValidFunction([null]);
      assert.equal(nullOnly(null), false);
      assert.equal(nullOnly(undefined), true);
      assert.equal(nullOnly(NaN), true);
      assert.equal(createIsValidFunction([])(null), true);
      assert.equal(createIsValidFunction()(undefined), true);
    }
    const db = new MemoryDB(process.argv[1], 2);
    try {
      const first = await db.store("alpha", { text: "alpha preference", vector: [1, 0], importance: 0.8, category: "preference" });
      await db.store("beta", { text: "beta fact", vector: [0, 1], importance: 0.5, category: "fact" });
      const rows = await db.search("alpha", [1, 0], 5, 0);
      assert.deepEqual(rows.map(({ entry }) => ({ id: entry.id, text: entry.text })), [
        { id: first.id, text: "alpha preference" },
      ]);
      assert.deepEqual((await db.list("beta")).map((row) => row.text), ["beta fact"]);
      db.close();
      const reopened = new MemoryDB(process.argv[1], 2);
      try {
        assert.deepEqual((await reopened.list("alpha")).map(({ id, text }) => ({ id, text })), [
          { id: first.id, text: "alpha preference" },
        ]);
      } finally {
        reopened.close();
      }
    } finally {
      db.close();
    }
    console.log("MemoryDB round trip and Arrow predicates passed for CommonJS and ESM");
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
  expect(result.stdout).toContain(
    "MemoryDB round trip and Arrow predicates passed for CommonJS and ESM",
  );
});

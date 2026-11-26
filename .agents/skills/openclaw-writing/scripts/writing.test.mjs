import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { checkCopy } from "./copy-check.mjs";
import { readGlossary, lookup } from "./glossary.mjs";

const entries = readGlossary();

test("lookup returns relevant meanings from the same source as copy checks", () => {
  assert.equal(
    entries.some((row) => row.use === "Use"),
    false,
    "Markdown headers are not terms",
  );
  assert.deepEqual(
    lookup(entries, "checkout").map((row) => row.use),
    ["workspace"],
  );
  assert.deepEqual(
    lookup(entries, "Worktree").map((row) => row.use),
    ["Worktree"],
  );
  assert.deepEqual(
    lookup(entries, "runtime").map((row) => row.use),
    ["harness"],
  );
  assert.deepEqual(
    lookup(entries, "saved sign-in").map((row) => row.use),
    ["account"],
  );
  const owners = lookup(entries, "owner");
  assert(owners.some((row) => row.use === "creator"));
  assert(owners.some((row) => row.use === "owner"));
  assert(owners.some((row) => row.use === "Claw owner"));
  assert(owners.length < entries.length);
  assert.deepEqual(lookup(entries, "not-a-product-term"), []);
  assert.throws(() => lookup(entries, " "), /nonempty/);
});

test("copy checks punctuation and only the selected meaning", () => {
  for (const text of ["Saving…", "Saving...", "Reply stopped; plan saved."]) {
    assert.equal(checkCopy(text, undefined, entries).length, 1);
  }
  assert.deepEqual(checkCopy("Saving", undefined, entries), []);
  assert.equal(checkCopy("Remove the saved sign-in.", "account", entries).length, 1);
  assert.equal(checkCopy("The runtime is unavailable.", "harness", entries).length, 1);
  assert.deepEqual(checkCopy("The language runtime is unavailable.", undefined, entries), []);
  assert.equal(checkCopy("Operator", "Teammate", entries).length, 1);
  assert.deepEqual(checkCopy("Teammate", "Teammate", entries), []);
  assert.deepEqual(checkCopy("Read access required.", "read access", entries), []);
  assert.equal(checkCopy("operator.read", "read access", entries).length, 1);
  assert.deepEqual(checkCopy("operatorXread", "read access", entries), []);
  assert.deepEqual(checkCopy("Add a Template", "Template", entries), []);
  assert.equal(checkCopy("Add a template", "Template", entries).length, 1);
  assert.throws(() => checkCopy("Text", "nonexistent", entries), /Unknown glossary meaning/);
});

test("CLI prints only matching rows and handles missing terms", () => {
  const script = new URL("./glossary.mjs", import.meta.url);
  const run = spawnSync(process.execPath, [script.pathname, "lookup", "checkout", "missing-term"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const [match, miss] = run.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(match.entries.length, 1);
  assert.equal(match.entries[0].use, "workspace");
  assert.deepEqual(miss.entries, []);
  const usage = spawnSync(process.execPath, [script.pathname], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

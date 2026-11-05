import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { inspectEvidence, EvidenceInspector } from "./evidence-files.js";
import { childEvalArgs, sourceModule, useTestTempDirs } from "./test-support.js";

const tempDirs = useTestTempDirs();

it("cached evidence failures release their inspector and invalidate when the file changes", async () => {
  const root = tempDirs.make("knowledge-verdict-retention-");
  await mkdir(path.join(root, "artifacts"));
  await writeFile(path.join(root, "artifacts/proof.txt"), "original evidence");
  await promisify(execFile)(
    process.execPath,
    [
      "--expose-gc",
      ...childEvalArgs(`
    import assert from "node:assert/strict";
    import { createHash } from "node:crypto";
    import { writeFileSync } from "node:fs";
    import { setImmediate } from "node:timers/promises";
    const { EvidenceInspector } = await import(${JSON.stringify(sourceModule("evidence-files"))});
    const root = ${JSON.stringify(root)}, verified = new Map();
    const now = Date.now;
    Date.now = () => now() + 10000;
    const citation = { path: "artifacts/proof.txt", sha256: createHash("sha256").update("replacement evidence").digest("hex") };
    function inspect() {
      const inspector = new EvidenceInspector(root, verified);
      try { inspector.inspect(citation); assert.fail("expected a failed citation"); }
      catch (error) { assert.equal(error.message, "Evidence hash or size does not match"); }
      return new WeakRef(inspector);
    }
    const weak = inspect();
    assert.equal(verified.size, 1);
    await setImmediate();
    globalThis.gc();
    globalThis.gc();
    assert.equal(weak.deref(), undefined, "cached verdict must not retain the request inspector");
    const next = new EvidenceInspector(root, verified);
    assert.throws(() => next.inspect(citation), /Evidence hash or size does not match/);
    writeFileSync(root + "/artifacts/proof.txt", "replacement evidence");
    assert.equal(new EvidenceInspector(root, verified).inspect(citation).sha256, citation.sha256);
  `),
    ],
    { timeout: 20000 },
  );
});

// The shared inspector replaces per-citation streaming reads, so it must return
// the same result or the same error as inspectEvidence for every citation shape.
it("EvidenceInspector matches inspectEvidence for every citation shape", async () => {
  const root = tempDirs.make("knowledge-inspector-");
  await mkdir(path.join(root, "artifacts"));
  const files = {
    "artifacts/crlf.txt": Buffer.from(
      `﻿${"x".repeat(3999)}😀tail\r\nnext "quoted" line\r\nthird\r\n`,
    ),
    "artifacts/lone-cr.txt": Buffer.from("alpha\rbeta\ngamma"),
    "artifacts/whole.txt": Buffer.from("ok 😀"),
    "artifacts/binary.bin": Buffer.from([0, 1, 2, 255, 254]),
    "artifacts/invalid.txt": Buffer.from([0x61, 0xff, 0x0a, 0x62]),
  };
  for (const [name, bytes] of Object.entries(files)) {
    await writeFile(path.join(root, name), bytes);
  }
  const sha = (name: keyof typeof files) => createHash("sha256").update(files[name]).digest("hex");
  const cite = (name: any, extra = {}) => ({ path: name, sha256: sha(name), ...extra });
  const citations = [
    cite("artifacts/crlf.txt"),
    cite("artifacts/crlf.txt", { start_line: 2, end_line: 3 }),
    cite("artifacts/crlf.txt", { start_line: 2, end_line: 2, quote: "quoted" }),
    cite("artifacts/crlf.txt", { start_line: 1, end_line: 1, quote: "third" }),
    cite("artifacts/crlf.txt", { start_line: 3, end_line: 9 }),
    cite("artifacts/crlf.txt", { start_line: 3, end_line: 2 }),
    cite("artifacts/crlf.txt", { size: files["artifacts/crlf.txt"].length }),
    cite("artifacts/crlf.txt", { size: 1 }),
    { path: "artifacts/crlf.txt", sha256: "0".repeat(64) },
    cite("artifacts/lone-cr.txt", { start_line: 1, end_line: 2 }),
    cite("artifacts/whole.txt"),
    cite("artifacts/binary.bin"),
    cite("artifacts/binary.bin", { quote: "x" }),
    cite("artifacts/binary.bin", { mediaType: "text/plain" }),
    cite("artifacts/invalid.txt"),
    cite("artifacts/invalid.txt", { start_line: 1, end_line: 1 }),
    cite("artifacts/invalid.txt", { quote: "a" }),
    { path: "artifacts/missing.txt", sha256: "0".repeat(64) },
    { path: "notes/outside.txt", sha256: "0".repeat(64) },
  ];
  const outcome = (run: any) => {
    try {
      return { value: run() };
    } catch (error) {
      // Both inspectors throw Error instances.
      return { error: (error as Error).message };
    }
  };
  const inspector = new EvidenceInspector(root);
  for (const citation of citations) {
    for (const preview of [0, 5, 4000, 20000]) {
      expect(
        outcome(() => inspector.inspect(citation, preview)),
        JSON.stringify({ citation, preview }),
      ).toStrictEqual(outcome(() => inspectEvidence(root, citation, preview)));
    }
  }
  expect(inspector.inspect(cite("artifacts/crlf.txt"), 4000)).toMatchObject({
    excerpt: "x".repeat(3999),
    excerptTruncated: true,
  });
  expect(inspector.inspect(cite("artifacts/whole.txt"), 4000).excerpt).toBe("ok 😀");
});

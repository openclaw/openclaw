// Run the frozen real-Gateway spawn workload with verified observer inputs.
// Compare phase 04 and its initializer request; keep cold and warm phases separate.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    harness: { type: "string" },
    hashes: { type: "string" },
    out: { type: "string" },
    "skip-build": { type: "boolean", default: false },
  },
});
assert(values.harness && values.hashes && values.out, "Pass --harness, --hashes and --out");
const hashes: Record<string, string> = JSON.parse(readFileSync(values.hashes, "utf8"));
for (const [name, expected] of Object.entries(hashes)) {
  const actual: string = createHash("sha256")
    .update(readFileSync(path.join(values.harness, name)))
    .digest("hex");
  assert.equal(actual, expected, `Frozen harness changed: ${name}`);
}
const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
assert.equal(git.status, 0, "Cannot resolve measured head");
const run = spawnSync(
  "python3",
  [
    path.join(values.harness, "measure.py"),
    "--repo",
    process.cwd(),
    "--out",
    values.out,
    "--sha",
    git.stdout.trim(),
    "--repetitions",
    "1",
    ...(values["skip-build"] ? ["--skip-build"] : []),
  ],
  { stdio: "inherit" },
);
if (run.error) {
  throw run.error;
}
process.exitCode = run.status ?? 1;

// node scripts/perf/prepared-workspace-verification.mjs <fixture-root> <baseline-module>
// Fresh processes, warm filesystem, five interleaved pairs. Acceptance: identical
// manifest, zero candidate content reads, lower median and p95 verification time.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2]);
const baseline = pathToFileURL(path.resolve(process.argv[3])).href;
const candidate = new URL(
  "../../src/gateway/worker-environments/workspace-manifest-script.generated.mjs",
  import.meta.url,
).href;
fs.mkdirSync(root, { recursive: true });
const workspace = path.join(root, "workspace");
fs.mkdirSync(workspace);
const fileCount = 4_000;
const bytesPerFile = 32 * 1024;
for (let i = 0; i < fileCount; i++) {
  fs.writeFileSync(path.join(workspace, `${i}.txt`), Buffer.alloc(bytesPerFile, i % 256));
}
const program = `
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
const { runWorkspaceManifestProgram } = await import(process.argv[1]);
const [workspace, home, prior] = process.argv.slice(2);
Date.now = () => ${Date.now() + 60_000};
let stdout = '';
const start = performance.now();
await runWorkspaceManifestProgram({
  argv: [process.execPath, workspace, '', 'all', ...(prior ? [prior] : []), 'memo-v1'],
  env: { HOME: home }, pid: process.pid, platform: process.platform,
  stdout: { write: value => { stdout += value; } },
}, () => '[]', () => {}, async () => { throw new Error('Plain fixture must not need Git'); }, 8 * 1024 * 1024);
const envelope = JSON.parse(stdout);
console.log(JSON.stringify({ ms: performance.now() - start, ...envelope.metrics, ref: envelope.manifestRef }));
`;
function capture(module, home, prior = "") {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--input-type=module", "-e", program, module, workspace, home, prior],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
      },
    ),
  );
}
const samples = { baseline: { rows: [] }, candidate: { rows: [] } };
for (const [name, module] of [
  ["baseline", baseline],
  ["candidate", candidate],
]) {
  const home = path.join(root, name);
  fs.mkdirSync(home);
  const initial = capture(module, home);
  assert.equal(initial.contentHashCount, fileCount);
  samples[name].initial = initial;
}
for (let i = 0; i < 5; i++) {
  for (const [name, module] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ]) {
    const row = capture(module, path.join(root, name), samples[name].initial.ref.slice(7));
    assert.equal(row.ref, samples.baseline.initial.ref);
    assert.equal(row.contentHashCount, name === "candidate" ? 0 : fileCount);
    samples[name].rows.push(row);
  }
}
const summary = Object.fromEntries(
  Object.entries(samples).map(([name, { rows }]) => {
    const times = rows.map((row) => row.ms).toSorted((a, b) => a - b);
    return [
      name,
      { samples: rows, medianMs: times[2], p95Ms: times[4], rangeMs: [times[0], times[4]] },
    ];
  }),
);
console.log(
  JSON.stringify(
    {
      workload: { fileCount, bytesPerFile, totalBytes: fileCount * bytesPerFile },
      filesystem: "warm OS cache; fresh process per capture; no provider snapshot",
      platform: process.platform,
      node: process.version,
      loadAverage: os.loadavg(),
      candidateModule: fileURLToPath(candidate),
      summary,
    },
    null,
    2,
  ),
);

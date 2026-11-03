/**
 * Measure the exact worktree reservation owner on a Git revision and working tree.
 * node scripts/perf/worktree-reservation-read-measure.mjs --base origin/main \
 *   --output .local/worktree-reservation-read
 * Four AB/BA pairs use fresh processes: untraced CPU, then inclusive allocation.
 * Each arm warms once, then scans 1,000 synthetic worktrees (4,000 missing reads).
 * Source capsules and raw results stay in --output; temporary fixtures are removed.
 */
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs, { readFile as readFileCallback } from "node:fs";
import promises from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { compileFunction } from "node:vm";
import { hasNodeErrorCode as hasErrnoCode } from "@openclaw/fs-safe/path";
import pMap from "p-map";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "origin/main" },
    output: { type: "string" },
    pairs: { type: "string", default: "4" },
    worker: { type: "string" },
    fixture: { type: "string" },
    mode: { type: "string" },
  },
});
const ownerPath = "src/agents/worktrees/base-ref.ts";
const files = [ownerPath, "src/infra/errno.ts", "src/utils/run-with-concurrency.ts"];
const sha256 = (source) => createHash("sha256").update(source).digest("hex");
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
function section(source, start, end) {
  const first = source.indexOf(start);
  const last = end ? source.indexOf(end, first) : source.length;
  assert(first >= 0 && last > first, `Source boundary missing: ${start}`);
  assert.equal(source.indexOf(start, first + 1), -1, `Ambiguous source boundary: ${start}`);
  return source.slice(first, last);
}
function loadOwner(sources) {
  const code = [
    section(sources[files[1]], "export function ignoreMissingPath").replace("export ", ""),
    section(sources[files[2]], "export async function runTasksWithConcurrency").replace(
      "export ",
      "",
    ),
    section(
      sources[ownerPath],
      "class LocalDefaultBusyError",
      "async function fastForwardLocalDefault",
    ),
  ].join("\n");
  const construct = compileFunction(
    `${stripTypeScriptTypes(code)}\nreturn assertWorktreeGitOperationsIdle;`,
    ["fs", "readFile", "path", "hasErrnoCode", "AsyncLocalStorage", "pMap"],
  );
  return construct(promises, readFileCallback, path, hasErrnoCode, AsyncLocalStorage, pMap);
}
if (values.worker) {
  assert(global.gc, "Worker requires --expose-gc");
  assert(values.fixture && ["cpu", "allocation"].includes(values.mode));
  const capsule = JSON.parse(fs.readFileSync(values.worker, "utf8"));
  const run = loadOwner(capsule.sources);
  await run(values.fixture, "refs/heads/main", {});
  global.gc();
  const inspector = values.mode === "allocation" ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const started = performance.now();
  const cpuStart = process.cpuUsage();
  await run(values.fixture, "refs/heads/main", {});
  const cpu = process.cpuUsage(cpuStart);
  const elapsedMs = performance.now() - started;
  let allocationBytes;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    const sum = (node) =>
      node.selfSize + node.children.reduce((bytes, child) => bytes + sum(child), 0);
    allocationBytes = sum(profile.head);
    inspector.disconnect();
  }
  console.log(
    JSON.stringify({
      label: capsule.label,
      revision: capsule.revision,
      hashes: capsule.hashes,
      mode: values.mode,
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      scans: 1,
      worktrees: 1000,
      reservationProbes: 4000,
      cpuMs: (cpu.user + cpu.system) / 1000,
      userMs: cpu.user / 1000,
      systemMs: cpu.system / 1000,
      elapsedMs,
      allocationBytes,
      hostLoad,
    }),
  );
} else {
  assert(values.output, "--output is required");
  const pairs = Number(values.pairs);
  assert(Number.isSafeInteger(pairs) && pairs >= 4, "--pairs must be at least 4");
  const output = path.resolve(values.output);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  const base = git("rev-parse", "--verify", `${values.base}^{commit}`).trim();
  for (const label of ["base", "candidate"]) {
    const sources = Object.fromEntries(
      files.map((file) => [
        file,
        label === "base" ? git("show", `${base}:${file}`) : fs.readFileSync(file, "utf8"),
      ]),
    );
    fs.writeFileSync(
      path.join(output, `${label}.json`),
      JSON.stringify({
        label,
        revision: label === "base" ? base : `working-tree@${git("rev-parse", "HEAD").trim()}`,
        hashes: Object.fromEntries(files.map((file) => [file, sha256(sources[file])])),
        sources,
      }),
    );
  }
  const fixture = fs.mkdtempSync(path.join(output, "fixture-"));
  try {
    for (let index = 0; index < 1000; index++) {
      const directory = path.join(fixture, "worktrees", String(index));
      fs.mkdirSync(directory, { recursive: true });
      for (const [name, content] of Object.entries({
        HEAD: `ref: refs/heads/synthetic-${index}\n`,
        gitdir: `/synthetic/${index}/.git\n`,
        commondir: "../..\n",
        index: "synthetic index metadata\n",
      })) {
        fs.writeFileSync(path.join(directory, name), content);
      }
    }
    const results = [];
    for (const mode of ["cpu", "allocation"]) {
      for (let pair = 1; pair <= pairs; pair++) {
        const order = pair % 2 ? ["base", "candidate"] : ["candidate", "base"];
        for (const label of order) {
          const raw = execFileSync(
            process.execPath,
            [
              "--expose-gc",
              fileURLToPath(import.meta.url),
              "--worker",
              path.join(output, `${label}.json`),
              "--fixture",
              fixture,
              "--mode",
              mode,
            ],
            { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "inherit"] },
          );
          const result = { pair, ...JSON.parse(raw) };
          results.push(result);
          fs.writeFileSync(path.join(output, "results.json"), JSON.stringify(results, null, 2));
          console.log(JSON.stringify(result));
        }
      }
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

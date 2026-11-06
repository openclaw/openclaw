#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [mode, ...args] = process.argv.slice(2);
const expectedKey =
  "setup-java-Linux-x64-gradle-194efd598202594ca8e871c54cebb3f156984f9bfacda95bdca1f69575a0ab65";

if (mode === "sample") {
  const [root, globPackage, upstreamSource, output] = args;
  process.chdir(root);
  process.env.GITHUB_WORKSPACE = root;
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(globPackage, "package.json"))).version,
    "0.7.0",
  );
  const source = fs.readFileSync(upstreamSource, "utf8");
  const declaration = source.match(/const GRADLE_BUILD_FILE_PATTERNS = (\[[\s\S]*?\])/);
  assert.ok(declaration, "Pinned provider must declare its hash patterns");
  const patterns = JSON.parse(declaration[1].replaceAll("'", '"'));
  const counts = {};
  let dependencyCalls = 0;
  const files = [];
  for (const name of ["lstat", "stat", "readdir", "realpath", "readlink"]) {
    counts[name] = 0;
    const original = fs.promises[name];
    fs.promises[name] = function (...parameters) {
      counts[name] += 1;
      if (String(parameters[0]).split(path.sep).includes("node_modules")) {
        dependencyCalls += 1;
      }
      return original.apply(this, parameters);
    };
  }
  const createReadStream = fs.createReadStream;
  fs.createReadStream = function (file, ...parameters) {
    files.push(path.relative(root, String(file)));
    return createReadStream.call(this, file, ...parameters);
  };
  syncBuiltinESMExports();
  const { hashFiles } = await import(pathToFileURL(path.join(globPackage, "lib/glob.js")));
  for (const name of Object.keys(counts)) {
    counts[name] = 0;
  }
  dependencyCalls = 0;
  files.length = 0;
  const cpuStart = process.cpuUsage();
  const started = performance.now();
  const hash = await hashFiles(patterns.join("\n"));
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStart);
  const key = `setup-java-${process.env.RUNNER_OS}-${process.arch}-gradle-${hash}`;
  assert.equal(key, expectedKey);
  assert.equal(files.length, 7);
  fs.writeFileSync(
    output,
    `${JSON.stringify({ key, files, elapsedMs, counts, dependencyCalls, cpuMs: (cpu.user + cpu.system) / 1000, maxRssKiB: process.resourceUsage().maxRSS })}\n`,
  );
} else if (mode === "campaign") {
  const [clean, installed, globPackage, upstreamSource, output] = args.map((arg) =>
    path.resolve(arg),
  );
  fs.mkdirSync(output, { recursive: true });
  const script = fileURLToPath(import.meta.url);
  const samples = [];
  const machine = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: os.availableParallelism(),
    model: os.cpus()[0]?.model,
    memoryBytes: os.totalmem(),
    loadBefore: os.loadavg(),
  };
  function sample(label, root, index, profile = false) {
    const prefix = `${label}-${index}`;
    const result = path.join(output, `${prefix}.json`);
    const log = fs.openSync(path.join(output, `${prefix}.log`), "w");
    try {
      execFileSync(
        process.execPath,
        [
          ...(profile
            ? ["--cpu-prof", `--cpu-prof-dir=${output}`, `--cpu-prof-name=${prefix}.cpuprofile`]
            : []),
          script,
          "sample",
          root,
          globPackage,
          upstreamSource,
          result,
        ],
        { stdio: ["ignore", log, "inherit"], timeout: 120_000 },
      );
    } finally {
      fs.closeSync(log);
    }
    return { label, index, ...JSON.parse(fs.readFileSync(result, "utf8")) };
  }
  // Prime the filesystem once; each measured hash still uses a fresh Node process.
  sample("after-dependencies", installed, "prime");
  sample("before-dependencies", clean, "prime");
  for (let index = 1; index <= 5; index += 1) {
    samples.push(sample("after-dependencies", installed, index));
    samples.push(sample("before-dependencies", clean, index));
  }
  function stats(label) {
    const rows = samples.filter((row) => row.label === label);
    const times = rows.map((row) => row.elapsedMs).toSorted((a, b) => a - b);
    return {
      medianMs: times[2],
      p95Ms: times[4],
      minMs: times[0],
      maxMs: times[4],
      maxRssKiB: Math.max(...rows.map((row) => row.maxRssKiB)),
      filesystemCalls: rows.map((row) => Object.values(row.counts).reduce((a, b) => a + b, 0)),
      dependencyCalls: rows.map((row) => row.dependencyCalls),
    };
  }
  const baseline = stats("after-dependencies");
  const candidate = stats("before-dependencies");
  const accepted =
    baseline.medianMs - candidate.medianMs >= 1000 &&
    candidate.p95Ms <= baseline.p95Ms &&
    candidate.maxRssKiB <= baseline.maxRssKiB * 1.2 &&
    candidate.dependencyCalls.every((count) => count === 0) &&
    baseline.dependencyCalls.every((count) => count > 0);
  fs.writeFileSync(
    path.join(output, "results.json"),
    `${JSON.stringify({ source: process.env.SOURCE_SHA, machine: { ...machine, loadAfter: os.loadavg() }, expectedKey, samples, baseline, candidate, accepted }, null, 2)}\n`,
  );
  sample("after-dependencies", installed, "profile", true);
  sample("before-dependencies", clean, "profile", true);
  console.log(JSON.stringify({ baseline, candidate, accepted }));
  assert.ok(accepted, "Candidate must meet the predeclared measurement rule");
} else {
  throw new Error("Expected sample or campaign mode");
}

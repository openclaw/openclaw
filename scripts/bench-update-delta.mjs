#!/usr/bin/env node
// Research control only: this does not create a Sparkle patch or an installable update.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

async function describeArtifact(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk);
  }
  return { name: path.basename(file), bytes: (await stat(file)).size, sha256: hash.digest("hex") };
}

function run(args) {
  const started = performance.now();
  const result = spawnSync("zstd", args, { encoding: "utf8" });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      "zstd exited with " + (result.status ?? result.signal) + ": " + result.stderr.trim(),
    );
  }
  return {
    wallMilliseconds: Math.round(performance.now() - started),
    stdout: result.stdout.trim(),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) {
    throw new Error("Usage: node scripts/bench-update-delta.mjs BASE TARGET NEW_OUTPUT_DIRECTORY");
  }
  const [base, target, output] = args.map((arg) => path.resolve(arg));
  const version = run(["--version"]).stdout;
  for (const file of [base, target]) {
    const info = await stat(file);
    // Bound input size and decode window, not peak memory; dictionaries and windows both consume RAM.
    if (!info.isFile() || info.size === 0 || info.size > 2 ** 29) {
      throw new Error("Benchmark inputs must be nonempty files no larger than 512 MiB");
    }
  }
  await mkdir(output);
  const patchPath = path.join(output, "archive.patch.zst");
  const reconstructedPath = path.join(output, "reconstructed.archive");
  const generation = run(["--patch-from=" + base, "--long=29", "-T1", target, "-o", patchPath]);
  const application = run([
    "--decompress",
    "--long=29",
    "--patch-from=" + base,
    patchPath,
    "-o",
    reconstructedPath,
  ]);
  const [baseArtifact, targetArtifact, patch, reconstructed] = await Promise.all(
    [base, target, patchPath, reconstructedPath].map(describeArtifact),
  );
  if (reconstructed.sha256 !== targetArtifact.sha256) {
    throw new Error(
      "Reconstruction SHA-256 does not match the target; no successful report written",
    );
  }
  const report = {
    schemaVersion: 1,
    purpose: "Archive-delta research control; NOT a Sparkle update or installer proof",
    codec: version,
    options: ["--long=29", "-T1"],
    base: baseArtifact,
    target: targetArtifact,
    patch,
    reconstructed,
    generationWallMilliseconds: generation.wallMilliseconds,
    applicationWallMilliseconds: application.wallMilliseconds,
    peakMemoryBytes: null,
    bytesSaved: targetArtifact.bytes - patch.bytes,
    transferFraction: patch.bytes / targetArtifact.bytes,
    reconstructionVerified: true,
    signatureVerified: false,
  };
  await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

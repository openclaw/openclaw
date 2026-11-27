/**
 * Measure the real package-boundary worker after preparing its declarations.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/extension-boundary-compile-measure.mts
 * REV_OR_SNAPSHOT_DIRECTORY_URL CONFIG [--count] [--manifest]. Use --warm as CONFIG
 * to measure package-boundary preparation with already-current SDK receipts.
 * Snapshots contain the worker/emitter, or the receipt input owner for --warm, at
 * their repository-relative paths. Alternate sources in fresh processes; use
 * external GNU time for CPU and peak RSS. Count runs are separate.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { availableParallelism, loadavg, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DeclarationLookup } from "../lib/native-declaration-filesystem.mts";
import { resolveRepoRoot } from "../lib/repo-root.mjs";

const root = resolveRepoRoot(import.meta.url);
const revision = process.argv[2];
const config = process.argv[3];
const warm = config === "--warm";
if (!revision || !config) {
  throw new Error("Expected a revision and prepared package-boundary config");
}
const sources = new Map(
  (warm
    ? ["scripts/lib/extension-boundary-inputs.mts"]
    : ["scripts/lib/native-declaration-emitter.mts", "scripts/compile-extension-boundary.mts"]
  ).map((owner) => [
    pathToFileURL(path.join(root, owner)).href,
    revision.startsWith("file:")
      ? fs.readFileSync(path.join(fileURLToPath(revision), owner), "utf8")
      : execFileSync("git", ["show", `${revision}:${owner}`], { cwd: root, encoding: "utf8" }),
  ]),
);
const hook = registerHooks({
  load(url, context, nextLoad) {
    const source = sources.get(url);
    return source !== undefined
      ? { format: "module-typescript", shortCircuit: true, source }
      : nextLoad(url, context);
  },
});
if (!warm) {
  fs.mkdirSync(path.join(root, ".artifacts"), { recursive: true });
}
const scratch = warm ? undefined : fs.mkdtempSync(path.join(root, ".artifacts/boundary-measure-"));
const inputReceipt = scratch ? path.join(scratch, "inputs.json") : undefined;
try {
  const counts = { exists: 0, nativeRealpath: 0 };
  const instrumented = process.argv.includes("--count");
  if (instrumented) {
    fs.existsSync = new Proxy(fs.existsSync, {
      apply(target, receiver, args) {
        counts.exists++;
        return Reflect.apply(target, receiver, args);
      },
    });
    fs.realpathSync.native = new Proxy(fs.realpathSync.native, {
      apply(target, receiver, args) {
        counts.nativeRealpath++;
        return Reflect.apply(target, receiver, args);
      },
    });
    syncBuiltinESMExports();
  }
  process.chdir(root);
  if (warm) {
    const recordPath = path.join(root, ".artifacts/extension-package-boundary/plugin-sdk.json");
    const before = fs.readFileSync(recordPath);
    const modified = fs.statSync(recordPath).mtimeMs;
    process.argv = [
      process.execPath,
      path.join(root, "scripts/prepare-extension-package-boundary-artifacts.mts"),
      "--mode=package-boundary",
    ];
    const started = performance.now();
    await import("../prepare-extension-package-boundary-artifacts.mts");
    const elapsedMs = performance.now() - started;
    if (
      (process.exitCode !== undefined && process.exitCode !== 0) ||
      modified !== fs.statSync(recordPath).mtimeMs ||
      !before.equals(fs.readFileSync(recordPath))
    ) {
      throw new Error("Warm preparation failed or replaced its SDK receipt");
    }
    console.log(
      JSON.stringify({
        revision,
        config,
        instrumented,
        elapsedMs,
        counts: instrumented ? counts : undefined,
        digest: createHash("sha256").update(before).digest("hex"),
        host: { cpus: availableParallelism(), ram: totalmem(), load: loadavg() },
      }),
    );
  } else {
    process.argv[2] = JSON.stringify({
      configFile: path.resolve(root, config),
      inputReceipt: inputReceipt!,
      emit: false,
    });
    const started = performance.now();
    await import("../compile-extension-boundary.mts");
    const elapsedMs = performance.now() - started;
    const result: { inputs: string[]; lookups: DeclarationLookup[] } = JSON.parse(
      fs.readFileSync(inputReceipt!, "utf8"),
    );
    const inputs = result.inputs;
    const digest = (lookups: typeof result.lookups) =>
      createHash("sha256")
        .update(JSON.stringify(inputs))
        .update(JSON.stringify(lookups))
        .digest("hex");
    const consumed = new Set(inputs.map((file) => path.resolve(root, file)));
    // Native resolution may repeat a positive existence probe for an already-read file.
    // Keep every other lookup, including negatives and positive probes outside the inputs.
    const semanticLookups = result.lookups.filter((lookup) => {
      const file = path.resolve(root, lookup.path);
      return !(
        lookup.kind === "fileExists" &&
        lookup.result &&
        consumed.has(file) &&
        fs.statSync(file, { throwIfNoEntry: false })?.isFile()
      );
    });
    console.log(
      JSON.stringify({
        revision,
        config,
        instrumented,
        elapsedMs,
        counts: instrumented ? counts : undefined,
        inputs: result.inputs.length,
        lookups: result.lookups.length,
        outputs: 0,
        digest: digest(result.lookups),
        semanticDigest: digest(semanticLookups),
        manifest: process.argv.includes("--manifest")
          ? { inputs, lookups: result.lookups }
          : undefined,
        host: { cpus: availableParallelism(), ram: totalmem(), load: loadavg() },
      }),
    );
  }
} finally {
  hook.deregister();
  if (scratch) {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

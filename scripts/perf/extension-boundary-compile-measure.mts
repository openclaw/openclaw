/**
 * Measure the real package-boundary worker after preparing its declarations.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/extension-boundary-compile-measure.mts
 * REV_OR_SNAPSHOT_DIRECTORY_URL CONFIG [--count] [--manifest]. Snapshots contain the
 * worker and emitter at their repository-relative paths. Alternate sources in fresh
 * processes; use external GNU time for CPU and peak RSS. Count runs are separate.
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
if (!revision || !config) {
  throw new Error("Expected a revision and prepared package-boundary config");
}
const sources = new Map(
  ["scripts/lib/native-declaration-emitter.mts", "scripts/compile-extension-boundary.mts"].map(
    (owner) => [
      pathToFileURL(path.join(root, owner)).href,
      revision.startsWith("file:")
        ? fs.readFileSync(path.join(fileURLToPath(revision), owner), "utf8")
        : execFileSync("git", ["show", `${revision}:${owner}`], { cwd: root, encoding: "utf8" }),
    ],
  ),
);
const hook = registerHooks({
  load(url, context, nextLoad) {
    const source = sources.get(url);
    return source !== undefined
      ? { format: "module-typescript", shortCircuit: true, source }
      : nextLoad(url, context);
  },
});
fs.mkdirSync(path.join(root, ".artifacts"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, ".artifacts/boundary-measure-"));
const inputReceipt = path.join(scratch, "inputs.json");
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
  process.argv[2] = JSON.stringify({
    configFile: path.resolve(root, config),
    inputReceipt,
    emit: false,
  });
  const started = performance.now();
  await import("../compile-extension-boundary.mts");
  const elapsedMs = performance.now() - started;
  const result: { inputs: string[]; lookups: DeclarationLookup[] } = JSON.parse(
    fs.readFileSync(inputReceipt, "utf8"),
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
} finally {
  hook.deregister();
  fs.rmSync(scratch, { recursive: true, force: true });
}

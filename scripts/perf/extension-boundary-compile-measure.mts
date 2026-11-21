/**
 * Measure one real package-boundary compiler request after preparing its declarations.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/extension-boundary-compile-measure.mts
 * REV_OR_FILE_URL CONFIG [--count] [--manifest]. Alternate sources in fresh processes; use external GNU time
 * for total CPU and peak RSS. Instrumented counts are separate from timing evidence.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { availableParallelism, loadavg, totalmem } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepoRoot } from "../lib/repo-root.mjs";

const root = resolveRepoRoot(import.meta.url);
const revision = process.argv[2];
const config = process.argv[3];
if (!revision || !config) {
  throw new Error("Expected a revision and prepared package-boundary config");
}
const owner = "scripts/lib/native-declaration-emitter.mts";
const ownerUrl = pathToFileURL(path.join(root, owner)).href;
const source = revision.startsWith("file:")
  ? fs.readFileSync(new URL(revision), "utf8")
  : execFileSync("git", ["show", `${revision}:${owner}`], {
      cwd: root,
      encoding: "utf8",
    });
const hook = registerHooks({
  load(url, context, nextLoad) {
    return url === ownerUrl
      ? { format: "module-typescript", shortCircuit: true, source }
      : nextLoad(url, context);
  },
});
try {
  const { compileNativeProject } = await import("../lib/native-declaration-emitter.mts");
  const { createDeclarationInputBoundary } = await import("../lib/local-check-runtime.mts");
  const boundary = createDeclarationInputBoundary(root);
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
  const started = performance.now();
  const result = await compileNativeProject({
    cwd: root,
    compilerRoot: root,
    configFile: path.resolve(root, config),
    assertInput: (file) => boundary.assert(file),
    diagnostics: "all",
    emit: false,
  });
  const elapsedMs = performance.now() - started;
  const inputs = result.inputs.map((file) => path.relative(root, file));
  const digest = createHash("sha256")
    .update(JSON.stringify(inputs))
    .update(JSON.stringify(result.lookups))
    .digest("hex");
  console.log(
    JSON.stringify({
      revision,
      config,
      instrumented,
      elapsedMs,
      counts: instrumented ? counts : undefined,
      inputs: result.inputs.length,
      lookups: result.lookups.length,
      outputs: result.outputFiles.size,
      digest,
      manifest: process.argv.includes("--manifest")
        ? { inputs, lookups: result.lookups }
        : undefined,
      host: { cpus: availableParallelism(), ram: totalmem(), load: loadavg() },
    }),
  );
} finally {
  hook.deregister();
}

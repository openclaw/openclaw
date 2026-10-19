import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { runBenchmarkEntrypoint } from "./lib/benchmark-harness.mts";
import { createSqliteSchemaAssetsPlugin } from "./lib/sqlite-schema-assets.mts";
import { createStateSchemaInlinePlugin } from "./lib/state-schema-inline-plugin.mts";
import {
  parseUtilityBenchmarkWorkload,
  utilityBenchmarkSources,
} from "./lib/utility-benchmark-workloads.mts";

await runBenchmarkEntrypoint("build-utility-decision-bench", async () => {
  const root = process.cwd();
  const workload = parseUtilityBenchmarkWorkload(process.argv[3] ?? "decision-transport");
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  // The same benchmark source is overlaid on each independently installed revision.
  // Refuse production edits: a revision label must identify the measured code.
  const sourceRevision = git("rev-parse", "--verify", `${process.argv[2] ?? "HEAD"}^{commit}`);
  git(
    "diff",
    "--exit-code",
    sourceRevision,
    "--",
    "src",
    "extensions",
    "packages",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "patches",
    "tsconfig.json",
  );
  if (git("ls-files", "--others", "--exclude-standard", "--", "src", "extensions", "packages")) {
    throw new Error("Untracked runtime source prevents binding the build to its revision");
  }
  const parent = path.join(root, ".artifacts", "utility-decision-bench", workload);
  mkdirSync(parent, { recursive: true });
  const outDir = mkdtempSync(path.join(parent, "build-"));
  const { entry, fixtures } = utilityBenchmarkSources[workload];
  const substitutedModule = "src/auto-reply/reply/progress-narrator-model.ts";
  let substitutions = 0;
  await build({
    config: false,
    cwd: root,
    entry: { worker: entry },
    outDir,
    format: "esm",
    platform: "node",
    tsconfig: path.join(root, "tsconfig.json"),
    dts: false,
    envPrefix: [],
    clean: false,
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: { codeSplitting: true },
    // Match native builds so imports retain canonical schemas and lazy catalogs.
    plugins: [
      createStateSchemaInlinePlugin(root),
      createSqliteSchemaAssetsPlugin(root),
      ...(workload === "progress-narration"
        ? [
            {
              name: "benchmark-narration-model",
              load(id: string) {
                // Only this exact resolved module is synthetic; the scheduler and
                // its activity, enablement and channel wiring remain production code.
                if (id !== path.join(root, substitutedModule)) {
                  return null;
                }
                substitutions++;
                return `export { prepareNarrationModel, generateNarrationWithUtilityModel } from ${JSON.stringify(path.join(root, "scripts/lib/bench-narration-model.ts"))};`;
              },
            },
          ]
        : []),
    ],
    deps: {
      // Match native runtime builds: workspace source is bundled; native package
      // bindings stay with the frozen installation for this exact revision.
      alwaysBundle: (id) =>
        (id.startsWith("@openclaw/") || id.startsWith("openclaw/")) &&
        !/^@openclaw\/(?:fs-safe|proc-safe)(?:\/|$)/u.test(id),
    },
    logLevel: "warn",
  });
  if (substitutions !== (workload === "progress-narration" ? 1 : 0)) {
    throw new Error("Benchmark model substitution did not match its declared boundary");
  }
  const smoke = spawnSync(process.execPath, [path.join(outDir, "worker.mjs"), "2"], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (smoke.error || smoke.status !== 0) {
    throw new Error(`Compiled worker smoke failed: ${smoke.error?.message ?? smoke.stderr}`);
  }
  process.stderr.write(smoke.stdout);
  const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const sourceHash = (files: readonly string[]) => {
    const hash = createHash("sha256");
    for (const file of files) {
      hash
        .update(file)
        .update("\0")
        .update(readFileSync(path.join(root, file)));
    }
    return hash.digest("hex");
  };
  const outputs = readdirSync(outDir, { recursive: true, withFileTypes: true })
    .filter((file) => file.isFile())
    .map((file) => path.relative(outDir, path.join(file.parentPath, file.name)))
    .toSorted()
    .map((file) => ({ file, sha256: sha256(path.join(outDir, file)) }));
  const manifest = path.join(outDir, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        sourceRevision,
        workload,
        substitutedModules: substitutions ? [substitutedModule] : [],
        lockfileSha256: sha256(path.join(root, "pnpm-lock.yaml")),
        workerSourceSha256: sourceHash([entry, ...fixtures]),
        buildSourceSha256: sourceHash([
          "scripts/build-utility-decision-bench.mts",
          "scripts/lib/utility-benchmark-workloads.mts",
        ]),
        harnessSourceSha256: createHash("sha256")
          .update(readFileSync(path.join(root, "scripts/lib/benchmark-harness.mts")))
          .update(readFileSync(path.join(root, "scripts/lib/arg-utils.mts")))
          .digest("hex"),
        node: process.version,
        entry: "worker.mjs",
        outputs,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(manifest);
});

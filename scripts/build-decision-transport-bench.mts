import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { build } from "tsdown";
import { listDirectoryTreeStrictSync } from "../src/infra/directory-walk.ts";
import { runBenchmarkEntrypoint } from "./lib/benchmark-harness.mts";
import { createSqliteSchemaAssetsPlugin } from "./lib/sqlite-schema-assets.mts";
import { createStateSchemaInlinePlugin } from "./lib/state-schema-inline-plugin.mts";

await runBenchmarkEntrypoint("build-decision-transport-bench", async () => {
  const root = process.cwd();
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  // Overlay the same committed benchmark on each revision. An owner-qualified
  // physical graph may serve them serially when all frozen inputs match; the
  // caller must have exclusive use and restore candidate source before gates.
  // Refuse production edits: a revision label must identify the measured code.
  const sourceRevision = git("rev-parse", "--verify", `${process.argv[2] ?? "HEAD"}^{commit}`);
  const workload = process.argv[3] ?? "http";
  if (!["http", "conversion", "runtime-v1"].includes(workload)) {
    throw new Error("Unknown benchmark case");
  }
  const benchmarkRevision =
    workload === "http"
      ? undefined
      : git("rev-parse", "--verify", `${process.argv[4] ?? "HEAD"}^{commit}`);
  if (benchmarkRevision) {
    if (realpathSync(path.join(root, "node_modules")) !== path.join(root, "node_modules")) {
      throw new Error("Production proof requires its owned physical application graph");
    }
    for (const file of [
      "scripts/bench-decision-transport.mts",
      "scripts/bench-decision-transport-worker.ts",
      "scripts/build-decision-transport-bench.mts",
      "scripts/lib/benchmark-harness.mts",
      "scripts/lib/arg-utils.mts",
    ]) {
      if (
        !readFileSync(path.join(root, file)).equals(
          execFileSync("git", ["show", `${benchmarkRevision}:${file}`], { cwd: root }),
        )
      ) {
        throw new Error(`Benchmark source differs from its committed provenance: ${file}`);
      }
    }
  }
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
  const parent = path.join(root, ".artifacts", "decision-transport-bench");
  mkdirSync(parent, { recursive: true });
  const outDir = mkdtempSync(path.join(parent, "build-"));
  const entry = "scripts/bench-decision-transport-worker.ts";
  await build({
    config: false,
    cwd: root,
    entry: { worker: entry },
    outDir,
    format: "esm",
    platform: "node",
    tsconfig: path.join(root, "tsconfig.json"),
    dts: false,
    sourcemap: true,
    envPrefix: [],
    clean: false,
    outExtensions: () => ({ js: ".mjs" }),
    outputOptions: { codeSplitting: true },
    // Match native builds so imports retain canonical schemas and lazy catalogs.
    plugins: [createStateSchemaInlinePlugin(root), createSqliteSchemaAssetsPlugin(root)],
    deps: {
      // Match native runtime builds: workspace source is bundled; native package
      // bindings stay with the frozen installation for this exact revision.
      alwaysBundle: (id) =>
        (id.startsWith("@openclaw/") || id.startsWith("openclaw/")) &&
        !/^@openclaw\/(?:fs-safe|proc-safe)(?:\/|$)/u.test(id),
    },
    logLevel: "warn",
  });
  const smoke = spawnSync(
    process.execPath,
    [path.join(outDir, "worker.mjs"), "2", ...(workload === "http" ? [] : [workload])],
    {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (smoke.error || smoke.status !== 0) {
    throw new Error(`Compiled worker smoke failed: ${smoke.error?.message ?? smoke.stderr}`);
  }
  process.stderr.write(smoke.stdout);
  const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  const outputs = listDirectoryTreeStrictSync(outDir)
    .filter(({ dirent }) => dirent.isFile())
    .map((walkEntry) => walkEntry.relativePath)
    .toSorted()
    .map((file) => ({ file, sha256: sha256(path.join(outDir, file)) }));
  const manifest = path.join(outDir, "manifest.json");
  writeFileSync(
    manifest,
    JSON.stringify(
      {
        sourceRevision,
        lockfileSha256: sha256(path.join(root, "pnpm-lock.yaml")),
        ...(benchmarkRevision
          ? {
              productionInputs: {
                benchmarkRevision,
                packageSha256: sha256(path.join(root, "package.json")),
                workspaceSha256: sha256(path.join(root, "pnpm-workspace.yaml")),
                builderSourceSha256: sha256(
                  path.join(root, "scripts/build-decision-transport-bench.mts"),
                ),
                installedLockfileSha256: sha256(path.join(root, "node_modules/.pnpm/lock.yaml")),
                modulesMetadataSha256: sha256(path.join(root, "node_modules/.modules.yaml")),
                platform: process.platform,
                arch: process.arch,
              },
            }
          : {}),
        workerSourceSha256: sha256(path.join(root, entry)),
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

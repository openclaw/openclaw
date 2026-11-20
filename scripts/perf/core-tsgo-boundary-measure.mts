/**
 * Measure the complete core graph boundary with unchanged compiler-resolved membership.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/core-tsgo-boundary-measure.mts [base-ref|-]
 * Alternate revisions in fresh processes; collect total CPU and peak RSS with external time.
 * Use --config-parity separately to compare all config roots and build-info paths.
 */
import childProcess, { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveRepoToolBinPath } from "../lib/local-check-runtime.mts";
import { resolveRepoRoot } from "../lib/repo-root.mjs";
import { TSGO_CORE_TEST_SHARDS } from "../lib/tsgo-core-test-shards.mts";

const root = resolveRepoRoot(import.meta.url);
const revision = process.argv[2] ?? "-";
if (revision === "--config-parity") {
  const { createNativeTypeScriptConfigReader } =
    await import("../lib/native-typescript-config.mts");
  const configs = [
    "test/tsconfig/tsconfig.core.test.json",
    ...TSGO_CORE_TEST_SHARDS.map((shard) => shard.config),
  ];
  const compiler = resolveRepoToolBinPath("tsgo", { cwd: root });
  const digest = createHash("sha256");
  using reader = createNativeTypeScriptConfigReader({ cwd: root });
  for (const config of configs) {
    const cli = JSON.parse(
      execFileSync(compiler, ["-p", config, "--showConfig"], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      }),
    ) as { files?: string[]; compilerOptions?: { tsBuildInfoFile?: string } };
    const parsed = reader.read(config);
    const normalize = (files: string[], buildInfo: string | undefined, directory: string) => ({
      files: files
        .map((file) => path.relative(root, path.resolve(directory, file)).replaceAll(path.sep, "/"))
        .toSorted(),
      buildInfo:
        buildInfo === undefined
          ? null
          : path.relative(root, path.resolve(directory, buildInfo)).replaceAll(path.sep, "/"),
    });
    const expected = normalize(
      cli.files ?? [],
      cli.compilerOptions?.tsBuildInfoFile,
      path.dirname(path.resolve(root, config)),
    );
    const actual = normalize(parsed.fileNames, parsed.options.tsBuildInfoFile, root);
    if (JSON.stringify(expected) !== JSON.stringify(actual)) {
      throw new Error(`Config parity failed: ${config}`);
    }
    digest.update(config).update(JSON.stringify(actual));
  }
  console.log(
    JSON.stringify({
      mode: "config-parity",
      configs: configs.length,
      digest: digest.digest("hex"),
    }),
  );
} else {
  const owner = "scripts/check-tsgo-core-boundary.mts";
  const ownerUrl = pathToFileURL(path.join(root, owner)).href;
  const source =
    revision === "-"
      ? undefined
      : execFileSync("git", ["show", `${revision}:${owner}`], {
          cwd: root,
          encoding: "utf8",
        });
  const hook = registerHooks({
    load(url, context, nextLoad) {
      return url === ownerUrl && source !== undefined
        ? { format: "module-typescript", shortCircuit: true, source }
        : nextLoad(url, context);
    },
  });
  const counts = { configQueries: 0, membershipQueries: 0, apiProcesses: 0 };
  childProcess.spawn = new Proxy(childProcess.spawn, {
    apply(target, receiver, args) {
      if (Array.isArray(args[1])) {
        if (args[1].includes("--showConfig")) counts.configQueries++;
        if (args[1].includes("--listFilesOnly")) counts.membershipQueries++;
        if (args[1].includes("--api")) counts.apiProcesses++;
      }
      return Reflect.apply(target, receiver, args);
    },
  });
  syncBuiltinESMExports();
  const { checkCoreTsgoGraphBoundary } = await import("../check-tsgo-core-boundary.mts");
  const started = performance.now();
  const graphs = await checkCoreTsgoGraphBoundary({ cwd: root });
  console.log(
    JSON.stringify({
      revision,
      elapsedMs: performance.now() - started,
      counts,
      graphs: graphs.length,
      roots: graphs.reduce((sum, graph) => sum + graph.roots.length, 0),
      files: graphs.reduce((sum, graph) => sum + graph.files.length, 0),
      digest: createHash("sha256").update(JSON.stringify(graphs)).digest("hex"),
      load: loadavg(),
    }),
  );
  hook.deregister();
}

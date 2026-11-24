/**
 * Measure the complete focused boundary lint on Linux with GNU time.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/boundary-reference-measure.mts REV
 * Only the plugin and forced-exit rule change; the checkout owns all other inputs.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { availableParallelism, loadavg, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { resolveRepoRoot } from "../lib/repo-root.mjs";

if (process.platform !== "linux") {
  throw new Error("This workload requires Linux and GNU /usr/bin/time");
}
const root = resolveRepoRoot(import.meta.url);
const revision = process.argv[2] ?? "HEAD";
const directory = mkdtempSync(path.join(tmpdir(), "boundary-reference-measure-"));
try {
  const plugin = path.join(directory, "plugin.mjs");
  writeFileSync(
    plugin,
    execFileSync("git", ["show", `${revision}:scripts/oxlint-boundary-guards.mjs`], {
      cwd: root,
    }),
  );
  const library = path.join(directory, "lib");
  mkdirSync(library);
  for (const entry of readdirSync(path.join(root, "scripts/lib"))) {
    if (entry !== "no-forced-process-exit.mjs") {
      symlinkSync(path.join(root, "scripts/lib", entry), path.join(library, entry));
    }
  }
  writeFileSync(
    path.join(library, "no-forced-process-exit.mjs"),
    execFileSync("git", ["show", `${revision}:scripts/lib/no-forced-process-exit.mjs`], {
      cwd: root,
    }),
  );
  const config = JSON.parse(
    readFileSync(path.join(root, "config/oxlint/boundary-guards.json"), "utf8"),
  );
  config.jsPlugins = [plugin];
  const configPath = path.join(directory, "config.json");
  writeFileSync(configPath, JSON.stringify(config));
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const [runtime, script, ...args] = manifest.scripts["lint:no-chained-type-assertions"].split(" ");
  if (runtime !== "node" || script !== "scripts/run-oxlint.mjs") {
    throw new Error("Unexpected focused boundary lint entrypoint");
  }
  const configIndex = args.indexOf("--config");
  if (configIndex < 0) {
    throw new Error("Focused lint has no config");
  }
  args[configIndex + 1] = configPath;
  const resources = path.join(directory, "resources.txt");
  const started = performance.now();
  const result = spawnSync(
    "/usr/bin/time",
    ["-f", "%U %S %M", "-o", resources, process.execPath, script, ...args, "--format", "json"],
    {
      cwd: root,
      env: {
        ...process.env,
        CI: "true",
        NODE_COMPILE_CACHE: path.join(directory, "compile-cache"),
      },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  const elapsedMs = performance.now() - started;
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error(result.stderr || `Lint exited ${result.status}`);
  }
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report.diagnostics) || !Number.isInteger(report.number_of_files)) {
    throw new Error("Focused lint did not return a complete diagnostic report");
  }
  const resourceLine = readFileSync(resources, "utf8").trim().split("\n").at(-1);
  const [userSeconds = Number.NaN, systemSeconds = Number.NaN, maxRssKiB = Number.NaN] = (
    resourceLine ?? ""
  )
    .split(/\s+/u)
    .map(Number);
  if (![userSeconds, systemSeconds, maxRssKiB].every(Number.isFinite)) {
    throw new Error("GNU time did not return complete CPU and RSS metrics");
  }
  console.log(
    JSON.stringify({
      revision,
      elapsedMs,
      cpuSeconds: userSeconds + systemSeconds,
      maxRssKiB,
      exitCode: result.status,
      files: report.number_of_files,
      diagnostics: report.diagnostics.length,
      digest: createHash("sha256")
        .update(
          JSON.stringify(
            report.diagnostics.map((entry: unknown) => JSON.stringify(entry)).toSorted(),
          ),
        )
        .digest("hex"),
      host: { cpus: availableParallelism(), ram: totalmem(), load: loadavg() },
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

/** Measure the complete focused boundary lint with a pinned baseline plugin or the current one. */
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRepoRoot } from "../lib/repo-root.mjs";

const root = resolveRepoRoot(import.meta.url);
const revision = process.argv[2] ?? "-";
const owner = "scripts/oxlint-boundary-guards.mjs";
const directory = mkdtempSync(path.join(tmpdir(), "boundary-guard-measure-"));
try {
  // Materialize both committed variants identically, including external CPU/RSS accounting.
  const plugin = path.join(directory, "plugin.mjs");
  writeFileSync(
    plugin,
    execFileSync("git", ["show", `${revision === "-" ? "HEAD" : revision}:${owner}`], {
      cwd: root,
    }),
  );
  symlinkSync(path.join(root, "scripts/lib"), path.join(directory, "lib"), "dir");
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
  if (configIndex < 0) throw new Error("Focused boundary lint has no config");
  args[configIndex + 1] = configPath;
  const started = performance.now();
  const result = spawnSync(process.execPath, [script, ...args, "--format", "json"], {
    cwd: root,
    env: { ...process.env, CI: "true" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const elapsedMs = performance.now() - started;
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    throw result.error ?? new Error(result.stderr || `Lint exited ${result.status}`);
  }
  const report = JSON.parse(result.stdout);
  if (!Array.isArray(report.diagnostics) || !Number.isInteger(report.number_of_files)) {
    throw new Error("Focused lint did not return a complete diagnostic report");
  }
  console.log(
    JSON.stringify({
      revision,
      elapsedMs,
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
    }),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

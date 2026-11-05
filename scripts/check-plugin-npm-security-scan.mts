// Full Release Validation runs this from the admitted publisher tooling P, in
// the candidate checkout, while its plugin npm preflight child packs with the
// candidate's own tooling. Plugin NPM Release repacks with P and scans with P's
// inventory, so a P-only bundler, lockfile, or inventory change would otherwise
// fail only at publish. Packs use P's packer (--tooling-root) on this checkout.
// Only packages with reviewed findings are packed: their reviewed hashes, paths,
// and counts are what toolchain drift breaks. Accepted gap: a package with no
// reviewed finding that gains one only under P still fails at publish.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runTasksWithConcurrency } from "../src/utils/run-with-concurrency.js";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import {
  reviewedCriticalFindingPackageNames,
  scanPluginNpmArtifactSecurity,
} from "./plugin-npm-security-scan.mts";

type PlannedPackage = { packageDir: string; packageName: string; version: string };

// Same per-command ceiling as the pretag pack check.
const PACK_TIMEOUT_MS = 10 * 60_000;

async function packAndScan(toolingRoot: string, outputRoot: string, plugin: PlannedPackage) {
  const outputDir = mkdtempSync(join(outputRoot, "pack-"));
  const status = await runManagedCommand({
    args: [
      join(toolingRoot, "scripts/plugin-npm-publish.sh"),
      "--repo-root",
      ".",
      "--pack",
      plugin.packageDir,
    ],
    bin: "bash",
    env: { ...process.env, OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR: outputDir },
    shell: false,
    requireProcessTreeExit: true,
    stdio: ["ignore", "ignore", "inherit"],
    timeoutMs: PACK_TIMEOUT_MS,
  });
  if (status !== 0) {
    throw new Error(`npm pack failed with exit code ${status}`);
  }
  const [tarball, ...extra] = readdirSync(outputDir).filter((name) => name.endsWith(".tgz"));
  if (!tarball || extra.length > 0) {
    throw new Error(`expected one packed tarball, found ${extra.length + (tarball ? 1 : 0)}`);
  }
  return scanPluginNpmArtifactSecurity({
    packageName: plugin.packageName,
    packageVersion: plugin.version,
    tarball: readFileSync(join(outputDir, tarball)),
  });
}

export async function scanWithPublisherTooling(toolingRoot: string, plan: PlannedPackage[]) {
  const reviewed = reviewedCriticalFindingPackageNames();
  const selected = plan.filter((plugin) => reviewed.has(plugin.packageName));
  const outputRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-publisher-scan-"));
  const failures: string[] = [];
  try {
    await runTasksWithConcurrency({
      limit: availableParallelism(),
      tasks: selected.map((plugin) => async () => {
        try {
          const report = await packAndScan(toolingRoot, outputRoot, plugin);
          console.log(
            `${report.packageName}: ${report.criticalFindingCount} critical findings, all reviewed`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          // The scanner already prefixes its findings with the package name.
          failures.push(
            message.startsWith(plugin.packageName) ? message : `${plugin.packageName}: ${message}`,
          );
        }
      }),
    });
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    throw new Error(
      [
        `Publisher tooling would reject ${failures.length} of ${selected.length} plugin npm packs at Plugin NPM Release:`,
        ...failures.toSorted(),
        "Each finding names the packed file and its new contentSha256. Review that file; if its behavior is unchanged, record the new hash or limit in scripts/plugin-npm-security-scan.mts on main, then validate and publish with tooling that contains the update.",
      ].join("\n"),
    );
  }
  console.log(
    `Publisher tooling accepts ${selected.length} plugin npm packs with reviewed findings.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [toolingFlag, toolingRoot, planFlag, planPath] = process.argv.slice(2);
  try {
    if (toolingFlag !== "--tooling-root" || !toolingRoot || planFlag !== "--plan" || !planPath) {
      throw new Error(
        "usage: check-plugin-npm-security-scan.mts --tooling-root <publisher-checkout> --plan <plugin-npm-release-plan.json>",
      );
    }
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as { all: PlannedPackage[] };
    await scanWithPublisherTooling(resolve(toolingRoot), plan.all);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

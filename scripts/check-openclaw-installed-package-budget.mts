import { appendFile, lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

// These caps and counting rules are frozen in already-published updaters
// (2026.9.3-2026.9.7), which cannot be patched. They charge every regular file's
// bytes, including npm's hidden node_modules/.package-lock.json; later readers
// that skip it are more lenient. Do not follow src/infra/package-update-integrity.ts.
const SHIPPED_DRIVER_CAP = { entries: 50_000, bytes: 1024 * 1024 * 1024 };
const INSTALLED_PACKAGE_BUDGET = { entries: 47_500, bytes: 900 * 1024 * 1024 };

type TreeSize = { entries: number; bytes: number };
type Contributor = TreeSize & { bucket: string };
type Measurement = TreeSize & { name: string; version: string; contributors: Contributor[] };

class UsageError extends Error {}

function contributorBucket(relative: string, isDirectory: boolean): string {
  const segments = relative.split("/");
  if (segments[0] === "node_modules") {
    return segments.slice(0, segments[1]?.startsWith("@") ? 3 : 2).join("/");
  }
  if (segments[0] === "dist" && segments.length > 1) {
    return segments.length > 2 || isDirectory ? `dist/${segments[1]}` : "dist/*";
  }
  return segments[0] ?? "";
}

export async function measureInstalledPackageTree(root: string): Promise<Measurement> {
  const packageRoot = path.resolve(root);
  let manifest: unknown;
  try {
    if (!(await lstat(packageRoot)).isDirectory()) {
      throw new Error("root must be a real directory, not a symlink or file");
    }
    manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    if (
      !manifest ||
      typeof manifest !== "object" ||
      !("version" in manifest) ||
      typeof manifest.version !== "string"
    ) {
      throw new Error("package.json must contain a string version");
    }
  } catch (error) {
    throw new UsageError(
      `Expected an installed OpenClaw package root such as <prefix>/lib/node_modules/openclaw with a package.json containing a string version: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const measurement: Measurement = {
    name: "name" in manifest && typeof manifest.name === "string" ? manifest.name : "openclaw",
    version: manifest.version,
    entries: 1,
    bytes: 0,
    contributors: [],
  };
  const contributors = new Map<string, Contributor>();

  // Serial awaits cost one threadpool round trip per entry (minutes on a loaded
  // host); totals are order-independent, so let libuv overlap the whole walk.
  async function walk(directory: string, relativeDirectory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    await Promise.all(
      children.map(async (child) => {
        const relative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name;
        const file = path.join(directory, child.name);
        let bytes = 0;
        if (child.isFile()) {
          const stat = await lstat(file);
          if (stat.isFile()) {
            bytes = stat.size;
          }
        }
        measurement.entries++;
        measurement.bytes += bytes;
        const bucket = contributorBucket(relative, child.isDirectory());
        const contributor = contributors.get(bucket) ?? { bucket, entries: 0, bytes: 0 };
        contributor.entries++;
        contributor.bytes += bytes;
        contributors.set(bucket, contributor);
        if (child.isDirectory()) {
          await walk(file, relative);
        }
      }),
    );
  }

  await walk(packageRoot, "");
  measurement.contributors = [...contributors.values()].toSorted(
    (left, right) => right.entries - left.entries || left.bucket.localeCompare(right.bucket, "en"),
  );
  return measurement;
}

export function evaluateInstalledPackageBudget(
  measurement: TreeSize,
  budget: TreeSize = INSTALLED_PACKAGE_BUDGET,
): Array<keyof TreeSize> {
  const dimensions: Array<keyof TreeSize> = ["entries", "bytes"];
  return dimensions.filter((dimension) => measurement[dimension] > budget[dimension]);
}

function formatEntries(entries: number): string {
  return entries.toLocaleString("en-US");
}

function formatBytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function main(): Promise<number> {
  const root = process.argv[2];
  if (process.argv.length !== 3 || root === undefined) {
    console.error("Usage: node scripts/check-openclaw-installed-package-budget.mts <root>");
    return 2;
  }
  const started = performance.now();
  const measurement = await measureInstalledPackageTree(root);
  const durationMs = performance.now() - started;
  const identity = `${measurement.name}@${measurement.version}`.replace(/[\r\n]/gu, " ");
  const summary = `Installed ${identity} tree: ${formatEntries(measurement.entries)} entries (budget ${formatEntries(INSTALLED_PACKAGE_BUDGET.entries)}; shipped updater cap ${formatEntries(SHIPPED_DRIVER_CAP.entries)}), ${formatBytes(measurement.bytes)} (budget ${formatBytes(INSTALLED_PACKAGE_BUDGET.bytes)}; cap ${formatBytes(SHIPPED_DRIVER_CAP.bytes)})`;
  console.log(summary);
  for (const contributor of measurement.contributors.slice(0, 10)) {
    console.log(
      `  ${contributor.bucket}: ${formatEntries(contributor.entries)} entries, ${formatBytes(contributor.bytes)}`,
    );
  }
  console.log(`Walk duration: ${durationMs.toFixed(1)} ms`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const markdownSummary = summary
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replace(/[\\`*_{}[\]()#+.!|]/gu, "\\$&");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdownSummary}\n`);
  }
  const exceeded = evaluateInstalledPackageBudget(measurement);
  for (const dimension of exceeded) {
    const format = dimension === "entries" ? formatEntries : formatBytes;
    const unit = dimension === "entries" ? " entries" : "";
    const prefix =
      process.env.GITHUB_ACTIONS === "true" ? "::error title=Installed package tree budget::" : "";
    console.error(
      `${prefix}Installed package tree has ${format(measurement[dimension])}${unit}, over the ${format(INSTALLED_PACKAGE_BUDGET[dimension])} budget (shipped updaters refuse trees over ${format(SHIPPED_DRIVER_CAP[dimension])}). Trim dependencies or dist output before release; see docs/ci/release-validation/package-acceptance.md#installed-package-tree-budget.`,
    );
  }
  return exceeded.length ? 1 : 0;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    process.exitCode = await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

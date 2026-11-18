import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  ANDROID_RELEASE_REF_PREFIX,
  resolveAndroidPublicBaselines,
  resolveAndroidStorePlan,
  validateAndroidStorePlan,
} from "./lib/android-store-version.ts";
import { resolveAndroidVersion } from "./lib/android-version.ts";

function main(): void {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      plan: { type: "string" },
      remote: { type: "string", default: "origin" },
    },
  });
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !["plan", "validate", "validate-baselines"].includes(command ?? "")
  ) {
    throw new Error(
      "Usage: android-release-plan.ts plan|validate|validate-baselines [--plan PATH] [--root DIR] [--remote origin]. Google Play snapshot JSON is read from stdin.",
    );
  }
  const rootDir = path.resolve(values.root ?? ".");
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  const refs = git("ls-remote", "--refs", values.remote!, `${ANDROID_RELEASE_REF_PREFIX}/*`)
    .split("\n")
    .filter(Boolean)
    .map((row) => {
      const [sha, ref, extra] = row.split(/\s+/u);
      if (
        !sha ||
        !/^[a-f0-9]{40}$/u.test(sha) ||
        !ref?.startsWith(`${ANDROID_RELEASE_REF_PREFIX}/`) ||
        extra
      ) {
        throw new Error(`Invalid Android source ref response: ${row}.`);
      }
      return { sha, ref };
    });
  const snapshot: unknown = JSON.parse(readFileSync(0, "utf8"));
  const saved = values.plan
    ? validateAndroidStorePlan(JSON.parse(readFileSync(values.plan, "utf8")))
    : null;
  if (command !== "plan" && !saved) {
    throw new Error(`${command} requires --plan.`);
  }
  if (command === "validate-baselines") {
    const actual = resolveAndroidPublicBaselines(snapshot, refs);
    if (JSON.stringify(actual) !== JSON.stringify(saved!.releaseNotesBaselines)) {
      throw new Error(
        "Google Play production releases changed after release notes were generated. Prepare a new Android release before uploading.",
      );
    }
    process.stdout.write(`${JSON.stringify(actual)}\n`);
    return;
  }
  const pinned = resolveAndroidVersion(rootDir);
  const packageJson = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as {
    version: string;
  };
  const plan = resolveAndroidStorePlan({
    gatewayVersion: packageJson.version,
    pinnedVersion: pinned.canonicalVersion,
    pinnedVersionCode: pinned.versionCode,
    sourceSha: git("rev-parse", "HEAD"),
    snapshot,
    refs,
  });
  if (command === "validate" && JSON.stringify(plan) !== JSON.stringify(saved)) {
    throw new Error(
      "Google Play release identity, next codes, or production baselines changed after preparation. Prepare a new Android release before uploading.",
    );
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

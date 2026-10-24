#!/usr/bin/env -S node --import tsx
// Verifies each version-bound official runtime's compatibility floor against this core: the runtime's
// own source at the floor release must still type-check here. Its private-local SDK imports are lazy
// and its pluginApi range is open-ended, so a floor that falls behind a removed export or a newly
// required argument only shows up as failing turns after an update.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareOpenClawReleaseVersions } from "../src/infra/npm-registry-spec.ts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { importToolingTypeScript } from "./lib/import-tooling-typescript.mts";

export type RuntimeFloorPlan =
  | { pluginId: string; floor: string; action: "check"; tag: string }
  | { pluginId: string; floor: string; action: "skip-unreleased" }
  | { pluginId: string; floor: string; action: "fail"; reason: string };

/** Decides, per version-bound runtime, whether its floor can and must be type-checked. */
export function planRuntimeFloorChecks(params: {
  hostVersion: string;
  candidates: readonly {
    pluginId: string;
    versionBoundToOpenClaw?: boolean;
    minimumCompatibleVersion?: string;
  }[];
  isReleased: (tag: string) => boolean;
  hasSource: (pluginId: string) => boolean;
}): RuntimeFloorPlan[] {
  const plans: RuntimeFloorPlan[] = [];
  for (const candidate of params.candidates) {
    const floor = candidate.minimumCompatibleVersion;
    if (!candidate.versionBoundToOpenClaw || !floor || !params.hasSource(candidate.pluginId)) {
      continue;
    }
    // A floor above this release would refuse the runtime published alongside it.
    if ((compareOpenClawReleaseVersions(floor, params.hostVersion) ?? 0) > 0) {
      plans.push({
        pluginId: candidate.pluginId,
        floor,
        action: "fail",
        reason: `floor ${floor} is newer than OpenClaw ${params.hostVersion}; the matching ${candidate.pluginId} release would be refused`,
      });
      continue;
    }
    const tag = `v${floor}`;
    // No published runtime exists at an unreleased floor, so nothing older can be admitted.
    plans.push(
      params.isReleased(tag)
        ? { pluginId: candidate.pluginId, floor, action: "check", tag }
        : { pluginId: candidate.pluginId, floor, action: "skip-unreleased" },
    );
  }
  return plans;
}

/**
 * Keeps compiler errors from the floor runtime's own files; any other error, or a failed compiler run
 * without diagnostics, means the check itself broke.
 */
export function partitionTypecheckErrors(output: string, sourcePrefix: string, exitStatus = 0) {
  const runtime: string[] = [];
  const other: string[] = [];
  for (const line of output.split("\n")) {
    if (!/\berror TS\d+:/u.test(line)) {
      continue;
    }
    (line.replaceAll("\\", "/").includes(sourcePrefix) ? runtime : other).push(line.trim());
  }
  if (exitStatus !== 0 && runtime.length === 0 && other.length === 0) {
    const tail = output.trim().split("\n").slice(-5).join("\n  ");
    other.push(`type-check exited ${exitStatus} without diagnostics${tail ? `:\n  ${tail}` : ""}`);
  }
  return { runtime, other };
}

function git(rootDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function isReleasedTag(rootDir: string, tag: string): boolean {
  try {
    git(rootDir, ["rev-parse", "-q", "--verify", `refs/tags/${tag}^{commit}`]);
    return true;
  } catch {
    // Release checkouts are shallow and tagless; ask the remote, then fetch just this tag.
    if (git(rootDir, ["ls-remote", "--tags", "origin", `refs/tags/${tag}`]).trim() === "") {
      return false;
    }
    git(rootDir, [
      "fetch",
      "--depth=1",
      "--no-tags",
      "origin",
      `+refs/tags/${tag}:refs/tags/${tag}`,
    ]);
    return true;
  }
}

function typecheckFloorSource(
  rootDir: string,
  plan: Extract<RuntimeFloorPlan, { action: "check" }>,
) {
  const workDir = path.join(rootDir, ".artifacts", "official-runtime-floor", plan.pluginId);
  const sourceRel = `extensions/${plan.pluginId}`;
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  const archive = execFileSync("git", ["archive", `${plan.tag}^{commit}`, sourceRel], {
    cwd: rootDir,
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", workDir], { input: archive });
  // Third-party dependencies resolve through the current workspace install of the same package.
  const installed = path.join(rootDir, sourceRel, "node_modules");
  if (existsSync(installed)) {
    symlinkSync(installed, path.join(workDir, sourceRel, "node_modules"), "dir");
  }
  const toRoot = path.relative(workDir, rootDir).replaceAll("\\", "/");
  writeFileSync(
    path.join(workDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        extends: `${toRoot}/tsconfig.json`,
        // The inherited rootDir would resolve against this directory; keep the checkout as root.
        compilerOptions: {
          rootDir: toRoot,
          noEmit: true,
          incremental: false,
          noUnusedLocals: false,
          noUnusedParameters: false,
        },
        include: [
          `${toRoot}/src/**/*.d.ts`,
          `${toRoot}/ui/src/**/*.d.ts`,
          `${sourceRel}/*.ts`,
          `${sourceRel}/src/**/*.ts`,
        ],
        exclude: [
          "**/*.test.ts",
          "**/test-support/**",
          "**/*test-helpers.ts",
          "**/*test-harness.ts",
          "**/*test-support.ts",
        ],
      },
      null,
      2,
    )}\n`,
  );
  let output: string;
  let exitStatus = 0;
  try {
    output = execFileSync(
      process.execPath,
      ["scripts/run-tsgo.mjs", "-p", path.join(workDir, "tsconfig.json")],
      {
        cwd: rootDir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string };
    output = `${failed.stdout ?? ""}\n${failed.stderr ?? ""}`;
    exitStatus = failed.status ?? 1;
  }
  const sourcePrefix = path.relative(rootDir, path.join(workDir, sourceRel)).replaceAll("\\", "/");
  return partitionTypecheckErrors(output, sourcePrefix, exitStatus);
}

type RuntimeFloorCandidates = Parameters<typeof planRuntimeFloorChecks>[0]["candidates"];

/** Loads the checked checkout's runtime catalog, not the copy beside this tooling script. */
export async function loadRuntimeFloorCandidates(
  rootDir: string,
): Promise<RuntimeFloorCandidates | undefined> {
  const catalogPath = path.join(rootDir, "src", "plugins", "official-runtime-plugins.ts");
  if (!existsSync(catalogPath)) {
    return undefined;
  }
  const catalog = await importToolingTypeScript(pathToFileURL(catalogPath).href, import.meta.url);
  const candidates = catalog.CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES;
  if (!Array.isArray(candidates)) {
    throw new Error(`official-runtime-floor: ${catalogPath} has no runtime candidate list.`);
  }
  return candidates as RuntimeFloorCandidates;
}

/**
 * Throws when a version-bound runtime's floor no longer works with the checkout at rootDir. The
 * release workflow runs trusted tooling against the release checkout, so the floors come from there.
 */
export async function checkOfficialRuntimeFloors(rootDir = process.cwd()): Promise<void> {
  const { version: hostVersion } = JSON.parse(
    readFileSync(path.join(rootDir, "package.json"), "utf8"),
  ) as {
    version: string;
  };
  const candidates = await loadRuntimeFloorCandidates(rootDir);
  if (!candidates) {
    console.log("official-runtime-floor: this checkout has no version-bound runtime floors.");
    return;
  }
  const plans = planRuntimeFloorChecks({
    hostVersion,
    candidates,
    isReleased: (tag) => isReleasedTag(rootDir, tag),
    hasSource: (pluginId) => existsSync(path.join(rootDir, "extensions", pluginId, "package.json")),
  });
  const failures: string[] = [];
  for (const plan of plans) {
    if (plan.action === "fail") {
      failures.push(`${plan.pluginId}: ${plan.reason}`);
    } else if (plan.action === "skip-unreleased") {
      console.log(
        `official-runtime-floor: ${plan.pluginId} floor ${plan.floor} is unreleased; nothing older is admitted.`,
      );
    } else {
      const errors = typecheckFloorSource(rootDir, plan);
      if (errors.other.length > 0) {
        failures.push(
          `${plan.pluginId}: type-check setup failed:\n  ${errors.other.slice(0, 10).join("\n  ")}`,
        );
      } else if (errors.runtime.length > 0) {
        failures.push(
          `${plan.pluginId} ${plan.floor} no longer type-checks against OpenClaw ${hostVersion}; raise its ` +
            `minimumCompatibleVersion in src/plugins/official-runtime-plugins.ts to the first release that does:\n  ` +
            errors.runtime.slice(0, 10).join("\n  "),
        );
      } else {
        console.log(
          `official-runtime-floor: ${plan.pluginId} ${plan.floor} type-checks against OpenClaw ${hostVersion}.`,
        );
      }
    }
  }
  if (failures.length > 0) {
    throw new Error(`official-runtime-floor:\n${failures.join("\n")}`);
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await checkOfficialRuntimeFloors();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

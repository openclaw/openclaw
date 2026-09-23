#!/usr/bin/env node
// Explicit repository preparation; source composition never selects a workload.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const WORKLOADS = new Set(["source", "gateway", "full"]);
const SOURCE_GUIDANCE =
  "[worktree-setup] Source-only: no dependencies installed or artifacts built. " +
  "For gateway work run node scripts/worktree-setup.mjs gateway; " +
  "for full preparation run node scripts/worktree-setup.mjs full.";
const FULL_TRANSITION = "Run git sparse-checkout disable, then retry preparation.";

function git(rootDir, args, input) {
  return execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
    input,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function readSparseState(rootDir) {
  const result = spawnSync("git", ["config", "--get", "--bool", "core.sparseCheckout"], {
    cwd: rootDir,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status === 1) {
    return false;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Cannot read Git sparse-checkout state.");
  }
  return result.stdout.trim() === "true";
}

function validateInputs(rootDir, workload) {
  const topLevel = git(rootDir, ["rev-parse", "--show-toplevel"]).trim();
  if (fs.realpathSync(topLevel) !== fs.realpathSync(rootDir)) {
    throw new Error("Run preparation from the target repository root.");
  }
  const sparse = readSparseState(rootDir);
  if (workload === "full" && sparse) {
    throw new Error("Full preparation requires full source. " + FULL_TRANSITION);
  }
  const tracked = git(rootDir, ["ls-files", "-z"]).split("\0").filter(Boolean);
  let required = tracked;
  if (sparse) {
    // Git interprets the repository-owned cone list. This helper has no profile
    // parser and never changes checkout state.
    const definition = path.join(rootDir, ".openclaw/worktree-profiles/gateway");
    if (!fs.existsSync(definition)) {
      throw new Error(
        "Sparse gateway preparation needs the repository gateway definition. " + FULL_TRANSITION,
      );
    }
    required = git(
      rootDir,
      ["sparse-checkout", "check-rules", "--cone", "--rules-file", definition, "-z"],
      tracked.join("\0") + "\0",
    )
      .split("\0")
      .filter(Boolean);
    const included = new Set(
      git(rootDir, ["sparse-checkout", "check-rules", "-z"], required.join("\0") + "\0")
        .split("\0")
        .filter(Boolean),
    );
    const excluded = required.filter((file) => !included.has(file));
    if (excluded.length > 0) {
      throw new Error(
        "Gateway inputs are excluded: " + excluded.slice(0, 10).join(", ") + ". " + FULL_TRANSITION,
      );
    }
  }
  const missing = required.filter((file) => !fs.existsSync(path.join(rootDir, file)));
  if (missing.length > 0) {
    throw new Error(
      "Tracked preparation inputs are missing: " +
        missing.slice(0, 10).join(", ") +
        ". " +
        FULL_TRANSITION,
    );
  }
  // The package/build inventories below use the filesystem. Validate first so
  // a missing tracked plugin cannot silently narrow the selected install.
  for (const file of [
    "package.json",
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "scripts/build-all.mts",
  ]) {
    if (!fs.existsSync(path.join(rootDir, file))) {
      throw new Error("Missing preparation input: " + file);
    }
  }
  return { sparse, tracked, requiredCount: required.length };
}

export async function createWorktreeSetupPlan({ rootDir, workload = "source", env = process.env }) {
  if (!WORKLOADS.has(workload)) {
    throw new Error("Unknown preparation workload: " + workload);
  }
  if (workload === "source") {
    return { workload, packageManager: null, install: null, build: null, requiredInputs: null };
  }
  const inputs = validateInputs(rootDir, workload);
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
  if (
    typeof pkg.packageManager !== "string" ||
    !/^pnpm@\d+\.\d+\.\d+(?:[-+].*)?$/u.test(pkg.packageManager)
  ) {
    throw new Error("Target package.json must pin pnpm through packageManager.");
  }
  const filters = new Set();
  if (workload === "gateway") {
    const { collectSourceCheckoutPluginBuildEntries } =
      await import("./lib/bundled-plugin-build-entries.mjs");
    const { readBundledPluginAssetHooks } = await import("./bundled-plugin-assets.mts");
    if (typeof pkg.name !== "string" || !pkg.name) {
      throw new Error("Target package.json is missing its package name.");
    }
    filters.add(pkg.name + "...");
    filters.add("./packages/*...");
    for (const entry of collectSourceCheckoutPluginBuildEntries({ cwd: rootDir, env })) {
      if (entry.hasPackageJson) {
        filters.add("./extensions/" + entry.id + "...");
      }
    }
    for (const phase of ["build", "copy"]) {
      for (const hook of await readBundledPluginAssetHooks({ rootDir, phase })) {
        filters.add(
          "./" + path.relative(rootDir, hook.pluginDir).split(path.sep).join("/") + "...",
        );
      }
    }
  }
  const filterArgs = [...filters]
    .toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .flatMap((filter) => ["--filter", filter]);
  return {
    workload,
    packageManager: pkg.packageManager,
    install: { command: "pnpm", args: [...filterArgs, "install", "--frozen-lockfile"] },
    build:
      workload === "gateway"
        ? {
            command: "node",
            args: ["--import", "./scripts/tsx.mjs", "scripts/build-all.mts", "qaRuntime"],
          }
        : { command: "pnpm", args: ["build"] },
    requiredInputs: { sparse: inputs.sparse, trackedFiles: inputs.requiredCount },
  };
}

function existingAncestor(target) {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Cannot inspect package store volume: " + target);
    }
    current = parent;
  }
  return current;
}

async function executePreparation(rootDir, workload) {
  const plan = await createWorktreeSetupPlan({ rootDir, workload });
  const { assertRealOutputRoot } = await import("./lib/output-root-guard.mjs");
  const { createPnpmRunnerSpawnSpec } = await import("./pnpm-runner.mts");
  const { runManagedCommand } = await import("./lib/managed-child-process.mts");
  const validateOutputRoots = () => {
    const manifests = git(rootDir, ["ls-files", "-z"])
      .split("\0")
      .filter((file) => file === "package.json" || file.endsWith("/package.json"));
    for (const manifest of manifests) {
      const packageRoot = path.join(rootDir, path.dirname(manifest));
      assertRealOutputRoot(path.join(packageRoot, "node_modules"));
    }
    assertRealOutputRoot(path.join(rootDir, "node_modules/.pnpm"));
    assertRealOutputRoot(path.join(rootDir, "dist"));
  };
  validateOutputRoots();
  const pnpm = (args) => createPnpmRunnerSpawnSpec({ cwd: rootDir, pnpmArgs: args });
  const capture = (args) => {
    const spec = pnpm(args);
    return execFileSync(spec.command, spec.args, {
      ...spec.options,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  };
  const version = capture(["--version"]);
  const pinnedVersion = plan.packageManager.slice("pnpm@".length).split("+")[0];
  if (version !== pinnedVersion) {
    throw new Error(
      "Expected repository pnpm " +
        pinnedVersion +
        ", got " +
        version +
        ". Run through the repository-pinned toolchain.",
    );
  }
  const storePath = capture(["store", "path"]);
  if (
    !path.isAbsolute(storePath) ||
    fs.statSync(existingAncestor(storePath)).dev !== fs.statSync(rootDir).dev
  ) {
    throw new Error("Preparation requires a pnpm store on the same volume as the worktree.");
  }
  // Do not trust a previously displayed plan as permission to prepare changed inputs.
  const current = await createWorktreeSetupPlan({ rootDir, workload });
  if (JSON.stringify(current) !== JSON.stringify(plan)) {
    throw new Error("Preparation inputs changed while checking the toolchain; retry.");
  }
  // Toolchain probes can take time; reject output roots linked since the first check.
  validateOutputRoots();
  for (const step of [current.install, current.build]) {
    const spec =
      step.command === "pnpm"
        ? pnpm(step.args)
        : {
            command: process.execPath,
            args: step.args,
            options: { cwd: rootDir, shell: false, stdio: "inherit" },
          };
    const status = await runManagedCommand({
      bin: spec.command,
      args: spec.args,
      ...spec.options,
      requireProcessTreeExit: process.platform !== "win32",
    });
    if (status !== 0) {
      return status;
    }
  }
  return 0;
}

export function parseWorktreeSetupArgs(argv) {
  let workload;
  let plan = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--plan") {
      plan = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (WORKLOADS.has(arg) && workload === undefined) {
      workload = arg;
    } else {
      throw new Error("Unexpected preparation argument: " + arg);
    }
  }
  return { workload: workload ?? "source", plan, help };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = parseWorktreeSetupArgs(process.argv.slice(2));
    if (args.help) {
      console.log(
        "Usage: node scripts/worktree-setup.mjs [source|gateway|full] [--plan]\n" + SOURCE_GUIDANCE,
      );
    } else if (args.plan) {
      console.log(
        JSON.stringify(
          await createWorktreeSetupPlan({ rootDir: process.cwd(), workload: args.workload }),
          null,
          2,
        ),
      );
    } else if (args.workload === "source") {
      console.log(SOURCE_GUIDANCE);
    } else {
      process.exitCode = await executePreparation(process.cwd(), args.workload);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { runManagedCommand } from "../lib/managed-child-process.mts";

// Admission scope, not a replacement compiler selector. Configuration,
// ambient and deleted inputs retain the existing planner's full fallback.
const compilerInput = (file: string) =>
  /\.[cm]?[jt]sx?$/.test(file) ||
  /(^|\/)(?:tsconfig[^/]*\.json|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.npmrc)$/.test(
    file,
  );

export async function verifyIntegrationFreshness(
  base: string,
  head: string,
  main: string,
  tree: string,
  mode = "verify",
) {
  const root = process.cwd();
  const git = (args: string[], env = process.env) =>
    execFileSync(process.env.OPENCLAW_PR_GIT || "git", args, {
      cwd: root,
      env,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  const paths = (from: string, to: string) =>
    git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      from,
      to,
      "--",
    ])
      .split("\0")
      .filter(Boolean);
  const incoming = paths(base, head);
  const candidateHasCompilerInputs = incoming.some(compilerInput);
  if (mode === "candidate") {
    return candidateHasCompilerInputs;
  }
  const drift = paths(base, main);
  if (!candidateHasCompilerInputs || !drift.some(compilerInput)) {
    return false;
  }
  if (mode === "local-only") {
    throw new Error(
      "Main advanced beyond integration proof during final authority verification; rerun merge-run before dispatch.",
    );
  }
  if (git(["merge-tree", "--write-tree", main, head]).trim() !== tree) {
    throw new Error("Integration proof merge tree does not match the selected main and head.");
  }
  const local = path.join(root, ".local");
  mkdirSync(local, { recursive: true });
  const scratch = mkdtempSync(path.join(local, "merge-static-"));
  const checkout = path.join(scratch, "checkout");
  mkdirSync(checkout);
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, "index") };
    git(["read-tree", tree], env);
    git(["checkout-index", "--all", "--prefix", checkout + path.sep], env);
    const changed = [...new Set([...incoming, ...drift])];
    const { resolveChangedCiTsgoInputs } = await import("../lib/tsgo-core-test-shards.mts");
    const fallback =
      "Integration static plan requires full fallback. Run prepare-sync-head and existing gates; no full suite was started.";
    if (!resolveChangedCiTsgoInputs(changed, (file) => existsSync(path.join(checkout, file)))) {
      throw new Error(fallback);
    }
    const { createChangedCiTypeCheckPlan } = await import("../run-tsgo-core-test-shards.mts");
    const { prepareTsgoCommand, runPreparedTsgoCommand } = await import("../run-tsgo.mts");
    // Keep workspace links inside the exact merge tree. Never borrow another
    // checkout's node_modules or execute package lifecycle scripts.
    const storeDir: unknown = parse(
      readFileSync(path.join(root, "node_modules/.modules.yaml"), "utf8"),
    )?.storeDir;
    if (typeof storeDir !== "string" || !storeDir) {
      throw new Error(
        "Prepared installation has no pnpm store; rerun preparation before admission.",
      );
    }
    const install = await runManagedCommand({
      bin: "pnpm",
      args: [
        "install",
        "--offline",
        "--frozen-lockfile",
        "--ignore-scripts",
        "--store-dir",
        storeDir,
      ],
      cwd: checkout,
      env: process.env,
      stdio: "inherit",
      requireProcessTreeExit: true,
    });
    if (install !== 0) {
      throw new Error(
        "Integration dependencies unavailable offline; prepare an isolated frozen install before retrying. No merge requested.",
      );
    }
    const plan = await createChangedCiTypeCheckPlan(changed, { cwd: checkout });
    if (plan.mode !== "changed") {
      throw new Error(fallback);
    }
    console.log(
      "Integration static proof: base=" +
        base +
        " main=" +
        main +
        " head=" +
        head +
        " tree=" +
        tree +
        "; graphs=" +
        plan.graphs.map((g) => g.name).join(","),
    );
    for (const graph of plan.graphs) {
      const command = prepareTsgoCommand(
        ["-p", graph.config, "--incremental", "false"],
        process.env,
        checkout,
      );
      if (!command) {
        throw new Error("Integration compiler was skipped; no proof recorded.");
      }
      const status = await runPreparedTsgoCommand(command);
      if (status !== 0) {
        throw new Error(
          "Integration static graph " +
            graph.name +
            " failed (exit " +
            status +
            "); no merge requested.",
        );
      }
    }
    console.log("Integration static proof passed for the exact main/head/tree above.");
    return true;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    const [base = "", head = "", main = "", tree = "", mode = "verify"] = process.argv.slice(2);
    if (![base, head, main, tree].every((oid) => /^[a-f0-9]{40}$/.test(oid ?? ""))) {
      throw new Error("Integration freshness requires exact base, head, main and tree OIDs.");
    }
    if (!["verify", "candidate", "local-only"].includes(mode)) {
      throw new Error("Unknown integration freshness mode.");
    }
    const needed = await verifyIntegrationFreshness(base, head, main, tree, mode);
    if (mode === "candidate") {
      console.log(needed ? "true" : "false");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

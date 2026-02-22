import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "pipe", encoding: "utf8" });
  return {
    code: r.status ?? 1,
    out: (r.stdout || "").trim(),
    err: (r.stderr || "").trim(),
  };
}

function hasGit() {
  return run("git", ["--version"]).code === 0;
}

if (!hasGit()) {
  process.exit(0);
}

const inside = run("git", ["rev-parse", "--is-inside-work-tree"]);
if (inside.code !== 0 || inside.out !== "true") {
  process.exit(0);
}

const hooksDir = resolve(process.cwd(), "git-hooks");
if (!existsSync(hooksDir)) {
  process.exit(0);
}

const set = run("git", ["config", "core.hooksPath", "git-hooks"]);
if (set.code !== 0) {
  // Non-fatal: never block install
  console.warn("prepare: unable to set git core.hooksPath (non-fatal).");
  if (set.err) {
    console.warn(set.err);
  }
  process.exit(0);
}

process.exit(0);

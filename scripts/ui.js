#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const uiDir = path.join(repoRoot, "ui");

function usage() {
  // keep this tiny; it's invoked from npm scripts too
  process.stderr.write(
    "Usage: node scripts/ui.js <install|dev|build|test> [...args]\n",
  );
}

function which(cmd) {
  try {
    const key = process.platform === "win32" ? "Path" : "PATH";
    const paths = (process.env[key] ?? process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean);
    const extensions =
      process.platform === "win32"
        ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
        : [""];
    for (const entry of paths) {
      for (const ext of extensions) {
        const candidate = path.join(entry, process.platform === "win32" ? `${cmd}${ext}` : cmd);
        try {
          if (fs.existsSync(candidate)) return candidate;
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveRunner() {
  const bun = which("bun");
  if (bun) return { cmd: bun, kind: "bun" };
  const pnpm = which("pnpm");
  if (pnpm) return { cmd: pnpm, kind: "pnpm" };
  return null;
}

function run(cmd, args) {
  const child = spawn(cmd, args, {
    cwd: uiDir,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 1);
  });
}

const [, , action, ...rest] = process.argv;
if (!action) {
  usage();
  process.exit(2);
}

const runner = resolveRunner();
if (!runner) {
  process.stderr.write(
    "Missing UI runner: install bun or pnpm, then retry.\n",
  );
  process.exit(1);
}

const script =
  action === "install"
    ? null
    : action === "dev"
      ? "dev"
      : action === "build"
        ? "build"
        : action === "test"
          ? "test"
          : null;

if (action !== "install" && !script) {
  usage();
  process.exit(2);
}

if (runner.kind === "bun") {
  if (action === "install") run(runner.cmd, ["install", ...rest]);
  else run(runner.cmd, ["run", script, ...rest]);
} else {
  if (action === "install") run(runner.cmd, ["install", ...rest]);
  else run(runner.cmd, ["run", script, ...rest]);
}

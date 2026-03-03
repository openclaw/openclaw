#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function ensureBuiltDist(repoRoot) {
  const candidates = [
    path.join(repoRoot, "dist", "entry.js"),
    path.join(repoRoot, "dist", "entry.mjs"),
  ];
  for (const candidate of candidates) {
    try {
      const stat = statSync(candidate);
      if (stat.isFile()) {
        return;
      }
    } catch {
      // try next candidate
    }
  }
  console.error(
    "check-plugin-dist-runtime: dist/entry.(m)js not found. Run `pnpm build:strict-smoke` first.",
  );
  process.exit(1);
}

function createPackArtifact(repoRoot, workDir) {
  const raw = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", workDir],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    },
  );
  const parsed = JSON.parse(raw);
  const filename = parsed?.[0]?.filename;
  if (!filename || typeof filename !== "string") {
    throw new Error("npm pack did not return a tarball filename");
  }
  return path.join(workDir, filename);
}

function extractPackArtifact(tarballPath, workDir) {
  const extractDir = path.join(workDir, "extract");
  mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarballPath, "-C", extractDir], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  return path.join(extractDir, "package");
}

function parsePluginsListJson(stdout) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const first = trimmed.indexOf("{");
    const last = trimmed.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(trimmed.slice(first, last + 1));
    }
    throw new Error("plugins list output did not contain valid JSON");
  }
}

function attachNodeModules(packageDir, repoRoot) {
  const source = path.join(repoRoot, "node_modules");
  const target = path.join(packageDir, "node_modules");
  try {
    const stat = statSync(source);
    if (!stat.isDirectory()) {
      throw new Error("not a directory");
    }
  } catch {
    throw new Error(
      "check-plugin-dist-runtime: node_modules not found in repo root. Run `pnpm install` first.",
    );
  }
  symlinkSync(source, target, "dir");
}

function runBundledPluginValidation(packageDir, workDir, repoRoot) {
  attachNodeModules(packageDir, repoRoot);
  const configPath = path.join(workDir, "openclaw.json");
  const stateDir = path.join(workDir, "state");
  writeFileSync(configPath, "{}\n", "utf8");
  mkdirSync(stateDir, { recursive: true });

  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["./openclaw.mjs", "plugins", "list", "--json"], {
      cwd: packageDir,
      env: {
        ...process.env,
        NODE_ENV: "production",
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_DISABLE_CONFIG_CACHE: "1",
        OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(packageDir, "extensions"),
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    });
  } catch (error) {
    const stdoutOut = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderrOut = typeof error.stderr === "string" ? error.stderr.trim() : "";
    const lines = [
      "check-plugin-dist-runtime: packaged `openclaw plugins list --json` failed",
      stdoutOut ? `stdout:\n${stdoutOut}` : null,
      stderrOut ? `stderr:\n${stderrOut}` : null,
    ].filter(Boolean);
    throw new Error(lines.join("\n\n"), { cause: error });
  }

  const payload = parsePluginsListJson(stdout);
  const plugins = Array.isArray(payload?.plugins) ? payload.plugins : [];
  const pluginErrors = plugins.filter((plugin) => plugin?.status === "error");
  const diagnostics = Array.isArray(payload?.diagnostics) ? payload.diagnostics : [];
  const diagnosticErrors = diagnostics.filter((diag) => diag?.level === "error");

  if (pluginErrors.length > 0 || diagnosticErrors.length > 0) {
    const lines = ["check-plugin-dist-runtime: detected plugin load errors from packed artifact"];
    for (const plugin of pluginErrors) {
      lines.push(`- plugin ${plugin?.id ?? "unknown"}: ${plugin?.error ?? "failed to load"}`);
    }
    for (const diag of diagnosticErrors) {
      const target =
        typeof diag?.pluginId === "string" && diag.pluginId ? `${diag.pluginId}: ` : "";
      lines.push(`- diagnostic ${target}${diag?.message ?? "unknown error"}`);
    }
    throw new Error(lines.join("\n"));
  }

  const bundledCount = plugins.filter((plugin) => plugin?.origin === "bundled").length;
  console.log(
    `check-plugin-dist-runtime: validated packaged plugin runtime (${bundledCount} bundled plugins discovered, ${plugins.length} total entries).`,
  );
}

async function main() {
  const repoRoot = process.cwd();
  ensureBuiltDist(repoRoot);
  const workDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-dist-runtime-"));
  const tarballPath = createPackArtifact(repoRoot, workDir);
  const packageDir = extractPackArtifact(tarballPath, workDir);
  runBundledPluginValidation(packageDir, workDir, repoRoot);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

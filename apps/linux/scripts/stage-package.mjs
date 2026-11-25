import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  desktopRuntimeReleaseTag,
  planDesktopRuntimePlugins,
  stampDesktopRuntimePlugins,
} from "../../../scripts/lib/desktop-runtime-plugins.mjs";
import { resolveNpmRunner } from "../../../scripts/npm-runner.mts";
import { pruneDesktopRuntime } from "../../../scripts/lib/desktop-runtime-prune.mjs";

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function resourceBytes(executable) {
  // linuxdeploy rewrites ELF resources even without executable permissions.
  // The seeder strips this envelope; hashes always cover the original bytes.
  return Buffer.concat([Buffer.from("OPENCLAW-BUN-RUNTIME-V1\n"), executable]);
}

export function stageInstalledPackage(installed, work, target, plan) {
  const manifestPath = path.join(work, "manifest.json");
  const previousManifest = fs.readFileSync(manifestPath);
  const manifest = JSON.parse(previousManifest);
  assert.equal(manifest.runtime?.flavor, "jit", "Packages can only be staged for the JIT desktop runtime");
  const core = path.join(installed, "node_modules/openclaw");
  assert.equal(readJson(path.join(core, "package.json")).name, "openclaw", "Expected the OpenClaw package");
  const require = createRequire(path.join(core, "package.json"));
  const platform = target.platform === "windows" ? "win32" : target.platform;
  assert.ok(require.resolve(`@openai/codex-${platform}-${target.arch}/package.json`),
    "The staged Codex platform package is missing");
  stampDesktopRuntimePlugins(core, plan);
  fs.writeFileSync(path.join(core, "openclaw-install-owner.json"), JSON.stringify({
    schemaVersion: 1,
    owner: "desktop-app",
    displayName: "OpenClaw desktop",
    updateHint: "Rebuild or update the desktop app to update this Gateway.",
  }));
  const destination = path.join(work, "package");
  fs.mkdirSync(destination);
  // The desktop invokes the entry with Bun; npm command links and locks are not runtime data.
  fs.cpSync(path.join(installed, "node_modules"), path.join(destination, "node_modules"),
    { recursive: true, dereference: true,
      filter: (source) => ![".bin", ".package-lock.json"].includes(path.basename(source)) });
  pruneDesktopRuntime(path.join(destination, "node_modules"));
  let bytes = 0;
  let resourceSize = 0;
  const record = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        record(file);
        if (fs.readdirSync(file).length === 0) {
          fs.rmdirSync(file);
        }
      }
      else {
        const content = fs.readFileSync(file);
        bytes += content.length;
        manifest.files[path.relative(work, file).split(path.sep).join("/")] =
          createHash("sha256").update(content).digest("hex");
        const resource = target.platform === "linux" ? resourceBytes(content) : content;
        resourceSize += resource.length;
        // Windows already has the copied bytes; only Linux needs the resource envelope.
        if (target.platform === "linux") {
          fs.writeFileSync(file, resource);
        }
      }
    }
  };
  record(destination);
  manifest.runtime.entry = "package/node_modules/openclaw/openclaw.mjs";
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  fs.writeFileSync(manifestPath, serialized);
  resourceSize += Buffer.byteLength(serialized) - previousManifest.length;
  console.error(`Staged same-commit Codex and core for ${platform}-${target.arch}: +${bytes} package bytes, +${resourceSize} resource bytes`);
  return bytes;
}

export function stagePackage(root, work, target) {
  const commit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Validate explicit release identity, while keeping every flavor self-contained.
  desktopRuntimeReleaseTag(root, readJson(path.join(root, "package.json")).version, commit);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tauri-package-"));
  try {
    const archive = path.join(scratch, "openclaw.tgz");
    execFileSync(process.execPath, [path.join(root, "scripts/package-openclaw-for-docker.mjs"),
      "--pnpm-pack", "--allow-unreleased-changelog", "--bundle-plugin", "codex",
      "--output-dir", scratch, "--output-name", "openclaw.tgz"], { cwd: root, stdio: "inherit" });
    const plan = planDesktopRuntimePlugins(root, { pluginIds: ["codex"] });
    const installed = path.join(scratch, "installed");
    const home = path.join(scratch, "home");
    fs.mkdirSync(installed);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(installed, "package.json"),
      JSON.stringify({ private: true, allowScripts: { [archive]: true } }));
    // Reuse only npm download bytes; the install and user configuration stay isolated.
    let npmCache;
    for (const [key, value] of Object.entries(process.env)) {
      if (key.toLowerCase() === "npm_config_cache" && value) npmCache = value;
    }
    const env = {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, HOME: home,
      USERPROFILE: home, TMPDIR: scratch, TEMP: scratch, TMP: scratch,
      npm_config_cache: npmCache,
    };
    const npm = resolveNpmRunner({ env, npmArgs: ["install", "--prefix", installed,
      "--omit=dev", "--include=optional", "--no-audit", "--no-fund",
      `--os=${target.platform === "windows" ? "win32" : target.platform}`, `--cpu=${target.arch}`,
      // Naming the archive avoids npm unpacking it just to discover its package name.
      `openclaw@file:${archive}`] });
    execFileSync(npm.command, npm.args, { cwd: scratch, stdio: "inherit", env: npm.env ?? env,
      windowsVerbatimArguments: npm.windowsVerbatimArguments });
    stageInstalledPackage(installed, work, target, plan);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

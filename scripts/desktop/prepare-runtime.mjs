#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const desktopRoot = path.join(repoRoot, "apps", "desktop");
const tauriRoot = path.join(desktopRoot, "src-tauri");
const binariesDir = path.join(tauriRoot, "binaries");
const runtimeDir = path.join(tauriRoot, "resources", "openclaw-runtime");
const pluginsDir = path.join(runtimeDir, "plugins");
const NODE_SIDECAR_BASENAME = "openclaw-node";
const MIN_NODE_VERSION = { major: 22, minor: 19, patch: 0 };

function hasFlag(flag) {
  return process.argv.slice(2).includes(flag);
}

function readPackageVersion() {
  const raw = readFileSync(path.join(repoRoot, "package.json"), "utf8");
  const parsed = JSON.parse(raw);
  return typeof parsed.version === "string" ? parsed.version : "dev";
}

function resolveTargetTriple() {
  const explicit = process.env.OPENCLAW_DESKTOP_TARGET_TRIPLE?.trim();
  if (explicit) {
    return explicit;
  }
  const output = execFileSync("rustc", ["-Vv"], { encoding: "utf8" });
  const host = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("host: "));
  if (!host) {
    throw new Error("Could not resolve Rust host target triple from `rustc -Vv`");
  }
  return host.slice("host: ".length).trim();
}

function resolveSidecarBinaryName(targetTriple) {
  const suffix = targetTriple.includes("windows") ? ".exe" : "";
  return `${NODE_SIDECAR_BASENAME}-${targetTriple}${suffix}`;
}

function resolveNodeBinary() {
  const explicit = process.env.OPENCLAW_DESKTOP_NODE_BINARY?.trim();
  if (explicit) {
    return path.resolve(explicit);
  }
  return process.execPath;
}

function assertUsableNode(nodeBinary) {
  if (!existsSync(nodeBinary)) {
    throw new Error(`Node binary does not exist: ${nodeBinary}`);
  }
  const version = execFileSync(nodeBinary, ["--version"], { encoding: "utf8" }).trim();
  const [major, minor, patch] = version
    .replace(/^v/u, "")
    .split(".")
    .map((part) => Number(part));
  const supported =
    Number.isInteger(major) &&
    Number.isInteger(minor) &&
    Number.isInteger(patch) &&
    (major > MIN_NODE_VERSION.major ||
      (major === MIN_NODE_VERSION.major &&
        (minor > MIN_NODE_VERSION.minor ||
          (minor === MIN_NODE_VERSION.minor && patch >= MIN_NODE_VERSION.patch))));
  if (!supported) {
    throw new Error(`OpenClaw desktop sidecar requires Node 22.19.0 or newer; got ${version}`);
  }
  return version;
}

function maybeCopyLobsterArtifact() {
  const explicit = process.env.OPENCLAW_DESKTOP_LOBSTER_TGZ?.trim();
  const target = path.join(pluginsDir, "openclaw-lobster.tgz");
  if (!explicit) {
    if (!existsSync(target)) {
      return false;
    }
    return true;
  }
  const source = path.resolve(explicit);
  if (!existsSync(source)) {
    throw new Error(`Bundled Lobster artifact does not exist: ${source}`);
  }
  copyFileSync(source, target);
  return true;
}

function maybeCopyOpenClawRuntime() {
  const explicit = process.env.OPENCLAW_DESKTOP_OPENCLAW_RUNTIME_DIR?.trim();
  const target = path.join(runtimeDir, "openclaw");
  if (!explicit) {
    return existsSync(path.join(target, "openclaw.mjs"));
  }
  const source = path.resolve(explicit);
  if (!existsSync(path.join(source, "openclaw.mjs"))) {
    throw new Error(`OpenClaw runtime dir must contain openclaw.mjs: ${source}`);
  }
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (sourcePath) => !sourcePath.includes(`${path.sep}.git${path.sep}`),
  });
  return true;
}

function writeRuntimeManifest(params) {
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    openclaw: {
      version: params.openclawVersion,
      source: params.dev ? "development-checkout" : "packaged-runtime",
      entrypoint: "openclaw/openclaw.mjs",
    },
    node: {
      version: params.nodeVersion,
      targetTriple: params.targetTriple,
      sidecar: NODE_SIDECAR_BASENAME,
    },
    plugins: [
      {
        id: "lobster",
        artifact: "plugins/openclaw-lobster.tgz",
        required: false,
        bundled: params.hasLobster,
      },
    ],
  };
  writeFileSync(
    path.join(runtimeDir, "runtime-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

function main() {
  const dev = hasFlag("--dev");
  const allowDevRuntimeFallback =
    dev ||
    hasFlag("--allow-dev-runtime-fallback") ||
    process.env.OPENCLAW_DESKTOP_ALLOW_DEV_RUNTIME_FALLBACK === "1";
  mkdirSync(binariesDir, { recursive: true });
  mkdirSync(pluginsDir, { recursive: true });

  const targetTriple = resolveTargetTriple();
  const nodeSource = resolveNodeBinary();
  const nodeVersion = assertUsableNode(nodeSource);
  const nodeTarget = path.join(binariesDir, resolveSidecarBinaryName(targetTriple));

  copyFileSync(nodeSource, nodeTarget);
  if (process.platform !== "win32") {
    chmodSync(nodeTarget, 0o755);
  }

  if (!dev && process.env.OPENCLAW_DESKTOP_CLEAN_RUNTIME === "1") {
    rmSync(path.join(runtimeDir, "openclaw"), { recursive: true, force: true });
  }

  const hasOpenClawRuntime = maybeCopyOpenClawRuntime();
  if (!allowDevRuntimeFallback && !hasOpenClawRuntime) {
    throw new Error(
      "Desktop release packaging requires OPENCLAW_DESKTOP_OPENCLAW_RUNTIME_DIR or an existing resources/openclaw-runtime/openclaw runtime. Pass --allow-dev-runtime-fallback or set OPENCLAW_DESKTOP_ALLOW_DEV_RUNTIME_FALLBACK=1 only for local shell testing.",
    );
  }

  const hasLobster = maybeCopyLobsterArtifact();
  if (hasFlag("--write-manifest") || process.env.OPENCLAW_DESKTOP_WRITE_RUNTIME_MANIFEST === "1") {
    writeRuntimeManifest({
      dev,
      hasLobster,
      nodeVersion,
      openclawVersion: readPackageVersion(),
      targetTriple,
    });
  }

  console.log(
    `[desktop] prepared Node sidecar ${path.relative(repoRoot, nodeTarget)} (${nodeVersion})`,
  );
  if (!hasLobster) {
    console.log("[desktop] no bundled Lobster artifact configured");
  }
  if (!hasOpenClawRuntime) {
    console.log(
      "[desktop] no packaged OpenClaw runtime configured; development checkout fallback remains enabled",
    );
  }
}

main();

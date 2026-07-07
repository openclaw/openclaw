#!/usr/bin/env node
// Builds OpenClaw native napi-rs modules.
// Phase 4: replaces heavy JS-native modules with Rust napi-rs bindings.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function nativeBuild() {
  const rootDir = process.cwd();
  const nativeDir = path.join(rootDir, "packages", "native");
  const crateDir = path.join(nativeDir, "crates", "native-core");
  const binaryName = "openclaw-native-core";
  const platform = process.env.OPENCLAW_NATIVE_BUILD_PLATFORM ?? process.platform;
  const isRelease = process.env.OPENCLAW_NATIVE_BUILD_RELEASE !== "0";
  const arch = process.env.OPENCLAW_NATIVE_BUILD_ARCH ?? process.arch;

  if (!fs.existsSync(path.join(crateDir, "Cargo.toml"))) {
    console.error("[native] crate not found, skipping native build");
    return;
  }

  // Check for Rust toolchain
  const rustc = spawnSync("rustc", ["--version"], { encoding: "utf8" });
  if (rustc.status !== 0) {
    console.error("[native] Rust toolchain not available, skipping native build");
    return;
  }
  console.error(`[native] ${rustc.stdout?.trim() ?? "unknown"}`);

  // Build args
  const target = resolveTarget(platform, arch);
  const args = ["build", "--cargo-cwd", crateDir];
  if (target) {
    args.push("--target", target);
  }
  if (isRelease) {
    args.push("--release");
  }

  // Run napi build
  const napiArgs = [...args];
  const result = spawnSync("npx", ["@napi-rs/cli", ...napiArgs], {
    cwd: nativeDir,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...process.env, npm_config_build_from_source: "true" },
  });

  if (result.status === 0) {
    console.error(`[native] built ${binaryName} successfully`);
    // Copy .node file to dist/native/
    const distNativeDir = path.join(rootDir, "dist", "native");
    fs.mkdirSync(distNativeDir, { recursive: true });
    const nodeFile = findNodeFile(crateDir, binaryName, target);
    if (nodeFile) {
      const dest = path.join(distNativeDir, `${binaryName}.node`);
      fs.copyFileSync(nodeFile, dest);
      console.error(`[native] copied to ${dest}`);
    }
  } else {
    console.error(`[native] build failed: ${result.stderr?.trim() ?? "unknown error"}`);
    // Non-fatal: native modules are optional optimizations
  }
}

function resolveTarget(platform, arch) {
  const map = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
    "linux-arm64": "aarch64-unknown-linux-gnu",
  };
  return map[`${platform}-${arch}`] ?? null;
}

function findNodeFile(crateDir, binaryName, target) {
  const releaseDir = path.join(crateDir, target ? `target/${target}/release` : "target/release");
  const debugDir = path.join(crateDir, target ? `target/${target}/debug` : "target/debug");
  const candidates = [
    path.join(releaseDir, `${binaryName}.node`),
    path.join(releaseDir, `${binaryName}.win32-x64-msvc.node`),
    path.join(debugDir, `${binaryName}.node`),
    path.join(debugDir, `${binaryName}.win32-x64-msvc.node`),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // Fallback: search in target directory
  const targetDir = path.join(crateDir, "target");
  if (!fs.existsSync(targetDir)) return null;
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const found = walkDir(path.join(dir, entry.name));
        if (found) return found;
      } else if (entry.name.endsWith(".node")) {
        return path.join(dir, entry.name);
      }
    }
    return null;
  };
  return walkDir(targetDir);
}

nativeBuild();

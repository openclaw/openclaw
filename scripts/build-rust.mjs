#!/usr/bin/env node
/**
 * Build Rust native modules for OpenClaw Mythos engines.
 *
 * This script runs `cargo build` for all mythos-* crates and copies
 * the generated .node files to the appropriate locations for Node.js
 * to load via require() / import().
 *
 * Usage:
 *   node scripts/build-rust.mjs [--release] [--crate <name>]
 *
 * Options:
 *   --release    Build in release mode (optimized)
 *   --crate <n>  Build only a specific crate
 *   --check      Check if Rust toolchain is available
 */

import { spawnSync } from "node:child_process";
import { existsSync, copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const CRATES_DIR = join(ROOT, "crates");

const CRATES = [
  "mythos-vector-engine",
  "mythos-search-engine",
  "mythos-embedding-runtime",
  "mythos-execution-sandbox",
  "mythos-protocol-codec",
  "mythos-causal-graph",
];

// Parse arguments
const args = process.argv.slice(2);
const release = args.includes("--release");
const checkOnly = args.includes("--check");
const crateIdx = args.indexOf("--crate");
const specificCrate = crateIdx >= 0 ? args[crateIdx + 1] : null;

// Check for Rust toolchain
function checkRustToolchain() {
  const result = spawnSync("cargo", ["--version"], { encoding: "utf-8" });
  if (result.status !== 0) {
    console.error("❌ Rust toolchain not found. Install from https://rustup.rs/");
    return false;
  }
  console.log(`✅ Rust toolchain: ${result.stdout.trim()}`);

  // Check for napi CLI
  const napiResult = spawnSync("npx", ["napi", "--version"], {
    encoding: "utf-8",
    shell: true,
  });
  if (napiResult.status === 0) {
    console.log(`✅ napi-rs CLI: ${napiResult.stdout.trim()}`);
  } else {
    console.log("⚠️  napi-rs CLI not found (optional, using cargo build directly)");
  }

  return true;
}

// Build a single crate
function buildCrate(crateName, isRelease) {
  const crateDir = join(CRATES_DIR, crateName);

  if (!existsSync(crateDir)) {
    console.error(`❌ Crate directory not found: ${crateDir}`);
    return false;
  }

  console.log(`\n🦀 Building ${crateName} (${isRelease ? "release" : "debug"})...`);

  const cargoArgs = ["build"];
  if (isRelease) {
    cargoArgs.push("--release");
  }
  cargoArgs.push("-p", crateName);

  const result = spawnSync("cargo", cargoArgs, {
    cwd: CRATES_DIR,
    encoding: "utf-8",
    stdio: "inherit",
  });

  if (result.status !== 0) {
    console.error(`❌ Failed to build ${crateName}`);
    return false;
  }

  // Find the built .node or .so/.dylib/.dll file
  const targetDir = join(CRATES_DIR, "target", isRelease ? "release" : "debug");
  const extensions = process.platform === "darwin" ? ["dylib", "so"] :
                     process.platform === "win32" ? ["dll", "lib"] :
                     ["so"];

  let foundNative = false;
  for (const ext of extensions) {
    // NAPI-RS produces files named like libmythos_vector_engine.so or mythos_vector_engine.dylib
    const libName = crateName.replace(/-/g, "_");
    const candidates = [
      join(targetDir, `lib${libName}.${ext}`),
      join(targetDir, `${libName}.${ext}`),
      join(targetDir, `lib${libName}.node`),
      join(targetDir, `${libName}.node`),
    ];

    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        console.log(`✅ Built: ${candidate}`);
        foundNative = true;

        // Copy to node_modules location for Node.js to find
        const destDir = join(ROOT, "node_modules", `@openclaw`, crateName);
        try {
          mkdirSync(destDir, { recursive: true });
          const destFile = join(destDir, `index.${ext === "dylib" ? "node" : ext === "dll" ? "node" : "node"}`);
          copyFileSync(candidate, destFile);
          console.log(`📦 Copied to: ${destFile}`);
        } catch (e) {
          // node_modules might not exist yet — that's OK for development
          console.log(`⚠️  Could not copy to node_modules (will be available after pnpm install)`);
        }
        break;
      }
    }
    if (foundNative) break;
  }

  if (!foundNative) {
    console.log(`⚠️  Built crate but native library not found in ${targetDir}`);
    console.log(`   Contents: ${readdirSync(targetDir).filter(f => f.includes(libNameFromCrate(crateName))).join(", ") || "(none)"}`);
  }

  return true;
}

function libNameFromCrate(crateName) {
  return crateName.replace(/-/g, "_");
}

// Main
if (checkOnly) {
  const ok = checkRustToolchain();
  process.exit(ok ? 0 : 1);
}

console.log("🦀 OpenClaw Rust Build System");
console.log(`   Mode: ${release ? "release (optimized)" : "debug"}`);
console.log(`   Crates: ${specificCrate || "all"}`);
console.log("");

if (!checkRustToolchain()) {
  process.exit(1);
}

const cratesToBuild = specificCrate ? [specificCrate] : CRATES;
let allOk = true;

for (const crate of cratesToBuild) {
  if (!buildCrate(crate, release)) {
    allOk = false;
  }
}

if (allOk) {
  console.log("\n✅ All Rust crates built successfully!");
} else {
  console.error("\n❌ Some crates failed to build.");
  process.exit(1);
}

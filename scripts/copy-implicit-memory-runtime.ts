#!/usr/bin/env tsx
/**
 * Copy implicit memory runtime assets from src to dist.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const verbose = process.env.OPENCLAW_BUILD_VERBOSE === "1";

const srcFile = path.join(projectRoot, "src", "memory", "memory_manager.py");
const distFile = path.join(projectRoot, "dist", "memory_manager.py");

function copyImplicitMemoryRuntime() {
  if (!fs.existsSync(srcFile)) {
    console.warn("[copy-implicit-memory-runtime] Source file not found:", srcFile);
    return;
  }

  const distDir = path.dirname(distFile);
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  fs.copyFileSync(srcFile, distFile);
  if (verbose) {
    console.log("[copy-implicit-memory-runtime] Copied memory_manager.py");
  }
  console.log("[copy-implicit-memory-runtime] Copied implicit memory runtime asset.");
}

copyImplicitMemoryRuntime();

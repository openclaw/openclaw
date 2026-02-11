// Minimal fresh-install sanity check for @openclaw/core-memories
// Run: node packages/core-memories/scripts/fresh-install-check.mjs

import { rmSync, existsSync } from "node:fs";
import path from "node:path";
import { getCoreMemories } from "../index.js";

const workspace = process.env.OPENCLAW_WORKSPACE || process.cwd();
const tmpDir = path.join(workspace, ".openclaw", "memory-fresh-install-test");

// Start clean
if (existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true, force: true });
}

const cm = await getCoreMemories({ memoryDir: tmpDir });
cm.addFlashEntry("remember this: core memories fresh install", "user", "conversation");

const ctx = cm.loadSessionContext();
if (!ctx.flash?.length) {
  throw new Error("Expected at least one flash entry");
}

// MEMORY.md integration is disabled by default; this should be 0
if (ctx.pendingMemoryMdUpdates !== 0) {
  throw new Error(`Expected pendingMemoryMdUpdates=0, got ${ctx.pendingMemoryMdUpdates}`);
}

console.log("OK: fresh install core-memories basic write/read works");

#!/usr/bin/env node
/**
 * Verify @claworks/runtime dist bundle loads and can start a minimal runtime.
 *
 * Usage:
 *   pnpm claworks:runtime:build && node --import tsx scripts/claworks-runtime-dist-smoke.mjs
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = join(root, "..", "claworks-packs");

const {
  createClaworksRuntime,
  startClaworksRuntime,
  stopClaworksRuntime,
  createClaworksRestHandler,
} = await import("../packages/claworks-runtime/dist/index.mjs");

const dir = mkdtempSync(join(tmpdir(), "cw-dist-smoke-"));
const runtime = await createClaworksRuntime({
  robot: { name: "dist-smoke", role: "monolith" },
  data: { database_url: `sqlite://${join(dir, "robot.db")}` },
  packs: {
    paths: [packsDir],
    installed: ["base", "process-industry"],
  },
});

await startClaworksRuntime(runtime);

const count = runtime.playbookEngine.list().length;
if (count < 5) {
  throw new Error(`expected playbooks from packs, got ${count}`);
}

const rest = createClaworksRestHandler(runtime);
if (typeof rest !== "function") {
  throw new Error("createClaworksRestHandler missing from dist");
}

await stopClaworksRuntime(runtime);
console.log(`[dist-smoke] OK (${count} playbooks, REST handler ready)`);

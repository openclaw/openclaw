#!/usr/bin/env node
/**
 * Live repro for openclaw docs MCP tool name (#82702).
 * Run: pnpm exec tsx scripts/repro/docs-mcp-search-tool-live-proof.mjs
 */
import { spawnSync } from "node:child_process";

function runMcporter(toolUrl, query) {
  const payload = JSON.stringify({ query });
  const res = spawnSync(
    "npx",
    ["-y", "mcporter", "call", toolUrl, "--args", payload, "--output", "text"],
    { encoding: "utf8", timeout: 60_000 },
  );
  return {
    code: res.status ?? 1,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

const query = "browser existing-session";
const wrong = "https://docs.openclaw.ai/mcp.SearchOpenClaw";
const right = "https://docs.openclaw.ai/mcp.search_open_claw";

console.log("=== Wrong tool (legacy SearchOpenClaw) ===");
const bad = runMcporter(wrong, query);
console.log("exit:", bad.code);
console.log(bad.stdout || bad.stderr);

console.log("\n=== Correct tool (search_open_claw) ===");
const good = runMcporter(right, query);
console.log("exit:", good.code);
const preview = (good.stdout || good.stderr).split("\n").slice(0, 6).join("\n");
console.log(preview);

const hasTitle = (good.stdout || "").includes("Title:");
console.log("\nhasTitle:", hasTitle);

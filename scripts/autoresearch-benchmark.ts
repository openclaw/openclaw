/**
 * Autoresearch benchmark: measures stable prefix of the OpenClaw system prompt.
 * Run with: bun scripts/autoresearch-benchmark.ts
 *
 * stable_chars = chars before the FIRST injected workspace file header
 *   (i.e. the `## /path/to/workspace/FILE.md` line).
 * That is the real Anthropic KV-cache boundary: everything before it is identical
 * across sessions; everything from the first file header onward changes as users
 * edit their workspace.
 *
 * Outputs METRIC lines for pi-autoresearch to capture.
 */

import os from "node:os";
import path from "node:path";
import { buildBootstrapContextFiles } from "../src/agents/pi-embedded-helpers/bootstrap.js";
import { buildAgentSystemPrompt } from "../src/agents/system-prompt.js";
import { loadWorkspaceBootstrapFiles } from "../src/agents/workspace.js";

const workspaceDir =
  process.env.BENCHMARK_WORKSPACE ?? path.join(os.homedir(), ".openclaw", "workspace");

// Representative static parameters (what doesn't change session-to-session)
const toolNames = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "grep",
  "find",
  "ls",
  "exec",
  "process",
  "web_search",
  "web_fetch",
  "browser",
  "canvas",
  "nodes",
  "cron",
  "message",
  "gateway",
  "agents_list",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "subagents",
  "session_status",
  "image",
  "memory_search",
  "memory_get",
];

// Load real workspace bootstrap files
const rawFiles = await loadWorkspaceBootstrapFiles(workspaceDir);
const contextFiles = buildBootstrapContextFiles(rawFiles, {
  maxChars: 20_000,
  totalMaxChars: 150_000,
});

// Build the system prompt with representative parameters
const prompt = buildAgentSystemPrompt({
  workspaceDir,
  toolNames,
  skillsPrompt:
    "<available_skills>\n  <skill>\n    <name>example-skill</name>\n    <description>An example skill for benchmarking</description>\n    <location>/path/to/skill.md</location>\n  </skill>\n</available_skills>",
  docsPath: "/Users/clawdine/.openclaw/workspace/projects/openclaw/docs",
  userTimezone: "America/Los_Angeles",
  modelAliasLines: [
    "- claude: claude-sonnet-4-5 (Anthropic)",
    "- claude-flash: claude-haiku-3-5 (Anthropic)",
    "- gemini: gemini-2.5-pro (Google)",
    "- gpt: gpt-4o (OpenAI)",
  ],
  contextFiles,
  runtimeInfo: {
    host: "benchmark-host",
    os: "darwin",
    arch: "arm64",
    node: "22.0.0",
    model: "claude-sonnet-4-5",
    channel: "imessage",
    capabilities: ["reactions"],
  },
  acpEnabled: true,
  promptMode: "full",
});

const totalChars = prompt.length;

// ── Dynamic boundary detection ──────────────────────────────────────────────
//
// The KV-cache boundary is the first injected workspace file header.
// Workspace files are injected as:   ## /path/to/workspace/FILENAME.md
// Everything before that line is identical across sessions (stable).
// Everything from that line onward changes as the user edits their workspace.
//
// Fallback: if no workspace files are present (edge case), use the model= line.

// Build patterns in priority order (first match wins)
const dynamicPatterns: { label: string; pattern: RegExp }[] = [
  // First injected workspace file header  (e.g. `## /home/user/.openclaw/workspace/AGENTS.md`)
  {
    label: "workspace-file-header",
    pattern: new RegExp(`^## ${escapeRegExp(workspaceDir)}/`, "m"),
  },
  // Also catch any absolute path that looks like a workspace file (portable fallback)
  {
    label: "workspace-file-header-abs",
    pattern: /^## \/[^\n]+\.md$/m,
  },
  // ISO timestamps (session timestamps injected dynamically)
  { label: "iso-timestamp", pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/ },
  // Explicit dynamic section headers (legacy guard)
  { label: "current-date-header", pattern: /## Current Date & Time/ },
  { label: "current-time", pattern: /Current time:/ },
];

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let stableChars = totalChars;
let hitLabel = "none";
for (const { label, pattern } of dynamicPatterns) {
  const match = pattern.exec(prompt);
  if (match && match.index < stableChars) {
    stableChars = match.index;
    hitLabel = label;
  }
}

console.log(`METRIC system_prompt_stable_chars=${stableChars}`);
console.log(`METRIC system_prompt_total_chars=${totalChars}`);
console.log(
  `stable_ratio=${((stableChars / totalChars) * 100).toFixed(1)}%  total=${totalChars} stable=${stableChars}  boundary=${hitLabel}`,
);

/**
 * Autoresearch benchmark: measures stable prefix of the OpenClaw system prompt.
 * Run with: bun scripts/autoresearch-benchmark.ts
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
// Use stable placeholders for session-variable params to measure real stable prefix
const prompt = buildAgentSystemPrompt({
  workspaceDir,
  toolNames,
  skillsPrompt:
    "<available_skills>\n  <skill>\n    <name>example-skill</name>\n    <description>An example skill for benchmarking</description>\n    <location>/path/to/skill.md</location>\n  </skill>\n</available_skills>",
  docsPath: "/Users/clawdine/.openclaw/workspace/projects/openclaw/docs",
  userTimezone: "America/Los_Angeles",
  // userTime is dynamic — leave undefined to simulate stable measurement
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
    // model is dynamic — use stable placeholder
    model: "DYNAMIC_MODEL_PLACEHOLDER",
    channel: "imessage",
    capabilities: ["reactions"],
  },
  acpEnabled: true,
  promptMode: "full",
});

const totalChars = prompt.length;

// Dynamic content patterns — anything that changes per-session.
// Workspace files (# Project Context section) are treated as dynamic because they
// change between sessions (MEMORY.md daily notes, project status files, etc.).
// Stable prefix = all boilerplate before the first workspace file or model placeholder.
const dynamicPatterns: RegExp[] = [
  // Workspace file content — changes as workspace evolves between sessions
  /^# Project Context$/m,
  // The model placeholder we inject to mark the per-session model boundary
  /DYNAMIC_MODEL_PLACEHOLDER/,
  // ISO timestamps (userTime, session timestamps)
  /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
  // Explicit dynamic section headers
  /## Current Date & Time/,
  // userTime: formatted current time in Time Zone section
  /Current time:/,
];

let stableChars = totalChars;
for (const pattern of dynamicPatterns) {
  const match = pattern.exec(prompt);
  if (match && match.index < stableChars) {
    stableChars = match.index;
  }
}

console.log(`METRIC system_prompt_stable_chars=${stableChars}`);
console.log(`METRIC system_prompt_total_chars=${totalChars}`);
console.log(
  `stable_ratio=${((stableChars / totalChars) * 100).toFixed(1)}%  total=${totalChars} stable=${stableChars}`,
);

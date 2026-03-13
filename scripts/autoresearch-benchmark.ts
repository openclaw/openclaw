/**
 * Autoresearch benchmark: measures stable prefix of the OpenClaw system prompt.
 * Run with: bun scripts/autoresearch-benchmark.ts
 *
 * Models real production usage: a group-chat session (WhatsApp/Telegram/Discord)
 * where the agent has a group-chat context string. This is the most common
 * OpenClaw deployment. The group-chat context (extraSystemPrompt) changes
 * per conversation, so it must come AFTER workspace files to avoid breaking
 * the Anthropic KV-cache prefix.
 *
 * stable_chars = chars before the first "most-dynamic" section.
 * Priority (most → least dynamic):
 *   1. ## Group Chat Context  — changes per conversation
 *   2. MEMORY.md header        — changes daily when present
 *   3. AGENTS.md header        — changes when guidelines update
 *   4. First workspace file    — fallback
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

// ── Group chat context (models real production usage) ────────────────────────
// This changes per conversation (different channel, different members joining).
// In production this is the most common scenario for OpenClaw deployments.
const GROUP_CHAT_EXTRA_PROMPT =
  "Channel: #family-chat (WhatsApp)\n" +
  "Members: Alice (+1-555-0101), Bob (+1-555-0102), Carol (+1-555-0103)\n" +
  "You were added by Alice. Respond to all members equally.\n" +
  "Current conversation has 847 messages in history.";

// Load real workspace bootstrap files
const rawFiles = await loadWorkspaceBootstrapFiles(workspaceDir);
const contextFiles = buildBootstrapContextFiles(rawFiles, {
  maxChars: 20_000,
  totalMaxChars: 150_000,
});

// Build the system prompt with representative parameters (group chat scenario)
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
  extraSystemPrompt: GROUP_CHAT_EXTRA_PROMPT,
  reactionGuidance: { level: "minimal", channel: "WhatsApp" },
  runtimeInfo: {
    host: "benchmark-host",
    os: "darwin",
    arch: "arm64",
    node: "22.0.0",
    model: "claude-sonnet-4-5",
    channel: "whatsapp",
    capabilities: ["reactions"],
  },
  acpEnabled: true,
  promptMode: "full",
});

const totalChars = prompt.length;

// ── Dynamic boundary detection ──────────────────────────────────────────────
// We find the EARLIEST "most-dynamic" section and use it as the stable boundary.
// Everything before it remains in the Anthropic KV-cache prefix cross-session.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Ordered: most-dynamic first
const boundaryPatterns: Array<{ label: string; pattern: RegExp }> = [
  // Group Chat Context: changes per conversation (most dynamic)
  { label: "group-chat-context", pattern: /^## Group Chat Context$/m },
  // Subagent Context: same as Group Chat Context but for subagent mode
  { label: "subagent-context", pattern: /^## Subagent Context$/m },
  // MEMORY.md: changes daily when present
  {
    label: "memory-md-header",
    pattern: new RegExp(`^## ${escapeRegExp(workspaceDir)}/(MEMORY|memory)\\.md$`, "m"),
  },
  // AGENTS.md: changes when workspace protocol/guidelines update
  {
    label: "agents-md-header",
    pattern: new RegExp(`^## ${escapeRegExp(workspaceDir)}/AGENTS\\.md$`, "m"),
  },
  // Fallback: first injected workspace file
  {
    label: "workspace-file-header",
    pattern: new RegExp(`^## ${escapeRegExp(workspaceDir)}/`, "m"),
  },
  // Legacy guards
  { label: "iso-timestamp", pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/ },
  { label: "current-date-header", pattern: /## Current Date & Time/ },
  { label: "current-time", pattern: /Current time:/ },
];

let stableChars = totalChars;
let hitLabel = "none";

for (const { label, pattern } of boundaryPatterns) {
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

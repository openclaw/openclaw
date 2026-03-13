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

// Build the system prompt with representative parameters (group chat + extended thinking scenario)
// reasoningLevel: "on" models the case where the user/agent has extended thinking enabled —
// a common config for coding agents and power users. When the reasoning level changes
// (user toggles /reasoning or a new session starts with a different default), the
// Reasoning line changes and breaks the KV cache prefix.
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
  reasoningLevel: "on",
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
// Stable prefix = everything before the EARLIEST "most-dynamic" section.
//
// We identify "primary dynamic" sections — content that changes between
// conversations or sessions. Stable workspace files (SOUL.md, USER.md, etc.)
// are NOT dynamic boundaries; only the most-frequently-changing sections are.
//
// Primary candidates (take minimum position of all that appear):
//   • ## Group Chat Context   — changes per conversation (channel, members)
//   • ## Subagent Context     — same, but for subagent sessions
//   • MEMORY.md header        — changes daily when present
//   • AGENTS.md header        — changes when workspace guidelines update
//
// Fallback (only if no primary candidate found):
//   • First workspace file header (SOUL.md, etc.)
//
// Legacy guards applied on top: ISO timestamps, "Current Date" headers.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Primary: any of these changing would invalidate the cache at that position
const primaryPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "group-chat-context", pattern: /^## Group Chat Context$/m },
  { label: "subagent-context", pattern: /^## Subagent Context$/m },
  // Reasoning line: `Reasoning: on/stream` breaks cache when reasoning is enabled.
  // The "off" default is stable; "on" and "stream" are per-session settings.
  { label: "reasoning-level", pattern: /\bReasoning: (on|stream)\b/m },
  // channel= and capabilities= change per conversation in multi-channel deployments
  { label: "channel-runtime", pattern: /\bchannel=\w/m },
  { label: "capabilities-runtime", pattern: /\bcapabilities=\w/m },
  {
    label: "memory-md-header",
    pattern: new RegExp(`^## ${escapeRegExp(workspaceDir)}/(MEMORY|memory)\\.md$`, "m"),
  },
  {
    label: "agents-md-header",
    pattern: new RegExp(`^## ${escapeRegExp(workspaceDir)}/AGENTS\\.md$`, "m"),
  },
];

// Fallback: first workspace file header (only if no primary candidate)
const firstFilePattern = new RegExp(`^## ${escapeRegExp(workspaceDir)}/`, "m");

// Legacy guards (timestamps, date headers)
const legacyPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "iso-timestamp", pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/ },
  { label: "current-date-header", pattern: /## Current Date & Time/ },
  { label: "current-time", pattern: /Current time:/ },
];

// Find the minimum position among primary candidates
let stableChars = totalChars;
let hitLabel = "none";

for (const { label, pattern } of primaryPatterns) {
  const match = pattern.exec(prompt);
  if (match && match.index < stableChars) {
    stableChars = match.index;
    hitLabel = label;
  }
}

// Fall back to first workspace file if no primary candidate was found
if (hitLabel === "none") {
  const firstFileMatch = firstFilePattern.exec(prompt);
  if (firstFileMatch) {
    stableChars = firstFileMatch.index;
    hitLabel = "workspace-file-header-fallback";
  }
}

// Apply legacy guards (can only tighten the boundary, never widen it)
for (const { label, pattern } of legacyPatterns) {
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

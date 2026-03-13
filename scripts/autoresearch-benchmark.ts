/**
 * Autoresearch benchmark: measures stable prefix of the OpenClaw system prompt.
 * Run with: bun scripts/autoresearch-benchmark.ts
 *
 * SCENARIO: Skills installation / model-aliases update.
 * Models a user who installs a new skill (or updates model aliases) while
 * workspace files, session config, and project notes remain unchanged.
 * Skills and model aliases are deployment-level config that changes when users
 * install new capabilities or update their model preferences.
 *
 * Method: build TWO prompts with identical parameters except skillsPrompt content
 * (1 skill vs 2 skills). Find the first character that differs.
 * Everything before that is the KV-cacheable stable prefix.
 *
 * stable_chars = first-diff position between prompt-with-skills-v1 and
 *                prompt-with-skills-v2.
 *
 * This is rigorous: it directly measures what Anthropic's KV cache would
 * actually reuse between skill installations.
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

// ── Skills installation scenario ─────────────────────────────────────────────
// Two versions of skillsPrompt simulate installing a new skill.
// Everything else (workspace files, channel, reasoning, workspaceNotes) stays the same.
const SKILLS_V1 =
  "<available_skills>\n" +
  "  <skill>\n" +
  "    <name>example-skill</name>\n" +
  "    <description>An example skill for benchmarking</description>\n" +
  "    <location>/path/to/skill.md</location>\n" +
  "  </skill>\n" +
  "</available_skills>";
const SKILLS_V2 =
  "<available_skills>\n" +
  "  <skill>\n" +
  "    <name>example-skill</name>\n" +
  "    <description>An example skill for benchmarking</description>\n" +
  "    <location>/path/to/skill.md</location>\n" +
  "  </skill>\n" +
  "  <skill>\n" +
  "    <name>new-skill</name>\n" +
  "    <description>A newly installed skill for advanced workflows</description>\n" +
  "    <location>/path/to/new-skill.md</location>\n" +
  "  </skill>\n" +
  "</available_skills>";

// Build the system prompt with representative parameters.
// Everything is IDENTICAL between the two prompts — only workspaceNotes differ
// (project A notes vs project B notes, representing a sprint/project update).
const sharedParams = {
  workspaceDir,
  toolNames,
  contextFiles,
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
  workspaceNotes: [
    "This project is a TypeScript CLI tool for OpenClaw.",
    "Current sprint: KV cache optimization for the bootstrap system prompt.",
  ],
  extraSystemPrompt: GROUP_CHAT_EXTRA_PROMPT,
  reactionGuidance: { level: "minimal", channel: "WhatsApp" },
  reasoningLevel: "on",
  // TTS hint: stable within the skills scenario
  ttsHint: "Reply with natural spoken language. Keep responses concise for voice delivery.",
  // Per-channel message tool hints: stable for a given channel
  messageToolHints: [
    "- For WhatsApp group chats: use reactions to acknowledge messages without noise.",
  ],
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
};

// Build two prompts: identical except skillsPrompt (1 skill vs 2 skills)
const prompt = buildAgentSystemPrompt({ ...sharedParams, skillsPrompt: SKILLS_V1 });
const promptV2 = buildAgentSystemPrompt({ ...sharedParams, skillsPrompt: SKILLS_V2 });

const totalChars = prompt.length;

// ── Skills scenario: find first diff between skills-v1 and skills-v2 ─────────
// This is the exact KV-cache stable prefix for "skillsPrompt changes".
// Everything before firstDiff is IDENTICAL between the two prompts and will
// be served from Anthropic's KV cache.
let firstDiff = 0;
while (
  firstDiff < prompt.length &&
  firstDiff < promptV2.length &&
  prompt[firstDiff] === promptV2[firstDiff]
) {
  firstDiff++;
}
const skillsScenarioStableChars = firstDiff;

// ── Pattern-based detection (used to identify WHAT the boundary is) ─────────
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
  // messageToolHints are per-channel (WhatsApp vs Telegram vs iMessage);
  // they appear inside the message tool subsection of ## Messaging.
  // These change every time the conversation switches channels.
  { label: "message-tool-hints", pattern: /^- For WhatsApp/m },
  // ttsHint: voice TTS config — changes when voice assistant is enabled/disabled or reconfigured.
  // Appears in ## Voice (TTS) section in the stable boilerplate.
  { label: "tts-hint", pattern: /^## Voice \(TTS\)$/m },
  // Inline buttons status text: changes between channels (supported on Telegram, not on WhatsApp)
  // The text "Inline buttons supported" OR "Inline buttons not enabled" is conditional on
  // inlineButtonsEnabled which depends on capabilities — a per-conversation value.
  { label: "inline-buttons-status", pattern: /^- Inline buttons (supported|not enabled)/m },
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

// PRIMARY METRIC: MEMORY.md daily scenario (first-diff between day-1 and day-2 prompts)
// This directly measures what Anthropic KV cache would reuse between daily note updates.
// SECONDARY (pattern-based): shows what the boundary is for pattern identification.
// PRIMARY METRIC: skills scenario (first-diff between skills-v1 and skills-v2 prompts)
// This directly measures what Anthropic KV cache would reuse between skill installations.
// SECONDARY (pattern-based): shows what the boundary is for pattern identification.
console.log(`METRIC system_prompt_stable_chars=${skillsScenarioStableChars}`);
console.log(`METRIC system_prompt_total_chars=${totalChars}`);
console.log(
  `stable_ratio=${((skillsScenarioStableChars / totalChars) * 100).toFixed(1)}%  total=${totalChars} stable=${skillsScenarioStableChars}  boundary=${hitLabel}(pattern) skills-diff=${skillsScenarioStableChars}`,
);

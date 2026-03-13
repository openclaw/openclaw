/**
 * Autoresearch benchmark: measures stable prefix of the OpenClaw system prompt.
 * Run with: bun scripts/autoresearch-benchmark.ts
 *
 * SCENARIO: Per-conversation (group chat context switch).
 * Models the most common session-start scenario: the same user starts a new
 * conversation (different group chat, or group chat members changed). All
 * deployment config, tools, skills, workspace notes, and memory stay the same.
 * Only the group chat context (extraSystemPrompt) changes.
 *
 * This is the MOST FREQUENT invalidation event — happens every time a user
 * opens a different conversation.
 *
 * Method: build TWO prompts with identical parameters except extraSystemPrompt
 * (v1 = group with Alice+Bob+Carol, v2 = group with Alice+Bob+Dave).
 * Find the first character that differs.
 *
 * stable_chars = first-diff position = KV-cacheable prefix for per-session changes.
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

// ── Per-conversation scenario ──────────────────────────────────────────────────
// Two versions of extraSystemPrompt: v1 = one group, v2 = different group.
// Everything else is IDENTICAL — same channel, same tools, same skills, etc.
const EXTRA_PROMPT_V1 =
  "Channel: #family-chat (WhatsApp)\n" +
  "Members: Alice (+1-555-0101), Bob (+1-555-0102), Carol (+1-555-0103)\n" +
  "You were added by Alice. Respond to all members equally.\n" +
  "Current conversation has 847 messages in history.";

const EXTRA_PROMPT_V2 =
  "Channel: #work-team (WhatsApp)\n" +
  "Members: Dave (+1-555-0201), Eve (+1-555-0202), Frank (+1-555-0203)\n" +
  "You were added by Dave. Focus on project coordination.\n" +
  "Current conversation has 312 messages in history.";

// Shared params: identical between v1 and v2 (only extraSystemPrompt differs)
const sharedParams = {
  workspaceDir,
  toolNames,
  contextFiles,
  docsPath: "/Users/clawdine/.openclaw/workspace/projects/openclaw/docs",
  ownerNumbers: ["+1-555-0101"],
  skillsPrompt:
    "<available_skills>\n  <skill>\n    <name>example-skill</name>\n    <description>An example skill for benchmarking</description>\n    <location>/path/to/skill.md</location>\n  </skill>\n</available_skills>",
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
  reactionGuidance: { level: "minimal", channel: "WhatsApp" },
  reasoningLevel: "on",
  ttsHint: "Reply with natural spoken language. Keep responses concise for voice delivery.",
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

// Build two prompts: identical except extraSystemPrompt (v1 = one conversation, v2 = another)
const promptV1 = buildAgentSystemPrompt({ ...sharedParams, extraSystemPrompt: EXTRA_PROMPT_V1 });
const promptV2 = buildAgentSystemPrompt({ ...sharedParams, extraSystemPrompt: EXTRA_PROMPT_V2 });

const totalChars = promptV1.length;

// ── Per-conversation scenario: find first diff ─────────────────────────────────
// This is the exact KV-cache stable prefix for "user switches to a different conversation".
let firstDiff = 0;
while (
  firstDiff < promptV1.length &&
  firstDiff < promptV2.length &&
  promptV1[firstDiff] === promptV2[firstDiff]
) {
  firstDiff++;
}
const perConversationStableChars = firstDiff;

// ── Pattern-based detection ────────────────────────────────────────────────────
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const primaryPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "group-chat-context", pattern: /^## Group Chat Context$/m },
  { label: "subagent-context", pattern: /^## Subagent Context$/m },
  { label: "reasoning-level", pattern: /\bReasoning: (on|stream)\b/m },
  { label: "message-tool-hints", pattern: /^- For WhatsApp/m },
  { label: "tts-hint", pattern: /^## Voice \(TTS\)$/m },
  { label: "inline-buttons-status", pattern: /^- Inline buttons (supported|not enabled)/m },
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

const firstFilePattern = new RegExp(`^## ${escapeRegExp(workspaceDir)}/`, "m");
const legacyPatterns: Array<{ label: string; pattern: RegExp }> = [
  { label: "iso-timestamp", pattern: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/ },
  { label: "current-date-header", pattern: /## Current Date & Time/ },
  { label: "current-time", pattern: /Current time:/ },
];

let stableChars = totalChars;
let hitLabel = "none";

for (const { label, pattern } of primaryPatterns) {
  const match = pattern.exec(promptV1);
  if (match && match.index < stableChars) {
    stableChars = match.index;
    hitLabel = label;
  }
}

if (hitLabel === "none") {
  const firstFileMatch = firstFilePattern.exec(promptV1);
  if (firstFileMatch) {
    stableChars = firstFileMatch.index;
    hitLabel = "workspace-file-header-fallback";
  }
}

for (const { label, pattern } of legacyPatterns) {
  const match = pattern.exec(promptV1);
  if (match && match.index < stableChars) {
    stableChars = match.index;
    hitLabel = label;
  }
}

// PRIMARY METRIC: per-conversation scenario (first-diff between v1 and v2 group chats)
console.log(`METRIC system_prompt_stable_chars=${perConversationStableChars}`);
console.log(`METRIC system_prompt_total_chars=${totalChars}`);
console.log(
  `stable_ratio=${((perConversationStableChars / totalChars) * 100).toFixed(1)}%  total=${totalChars} stable=${perConversationStableChars}  boundary=${hitLabel}(pattern) per-conv-diff=${perConversationStableChars}`,
);

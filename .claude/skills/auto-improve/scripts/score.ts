#!/usr/bin/env bun
/**
 * Auto-Improve Scoring Script (prepare.py equivalent)
 *
 * Deterministic evaluation harness for the auto-improve agent.
 * Reads session JSONL logs, computes all 9 metrics, outputs structured results.
 *
 * Usage:
 *   bun .claude/skills/auto-improve/scripts/score.ts [--sessions N] [--json] [--agent main|neo|morpheus|trinity|all]
 *
 * Options:
 *   --sessions N   Number of most recent sessions to analyze (default: 5)
 *   --json         Output as JSON instead of human-readable table
 *   --agent NAME   Score a specific agent or "all" (default: all)
 *   --tsv-row      Output a single TSV row suitable for appending to results.tsv
 *   --diagnostics  Output detected platform issues as JSON (for GitHub issue creation)
 */

import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const HOME = homedir();
const SESSIONS_BASE = join(HOME, ".openclaw/agents");
const WORKSPACES_BASE = resolve(join(HOME, "dev/operator1/workspaces"));

const AGENTS = ["main", "neo", "morpheus", "trinity"] as const;
type AgentId = (typeof AGENTS)[number];

const AGENT_WORKSPACE_MAP: Record<AgentId, string> = {
  main: "operator1",
  neo: "neo",
  morpheus: "morpheus",
  trinity: "trinity",
};

// Composite score weights (Operator1 only)
const WEIGHTS = {
  delegation: 0.3,
  memory: 0.2,
  conciseness: 0.15,
  silent_reply: 0.15,
  error_rate: 0.2,
};

// Context trigger pattern for memory usage
const CONTEXT_TRIGGER =
  /\b(remember|last time|before|earlier|yesterday|previous|we discussed|you said|I told you|what was|did we|pending|todo|remind me|what happened)\b/i;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionEntry {
  type: string;
  id?: string;
  message?: {
    role: "user" | "assistant" | "toolResult";
    content: ContentItem[];
  };
  [key: string]: unknown;
}

interface ContentItem {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  arguments?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  content?: string | ContentItem[];
  isError?: boolean;
  is_error?: boolean;
  [key: string]: unknown;
}

interface AgentScores {
  agent: AgentId;
  sessions_analyzed: number;
  delegation: number;
  memory: number;
  conciseness: number;
  silent_reply: number;
  error_rate: number;
  composite: number;
  tool_exec_rate: number;
  memory_writeback: number;
  memory_richness: number;
}

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function getArg(name: string, defaultVal: string): string {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return defaultVal;
  return args[idx + 1];
}
const hasFlag = (name: string) => args.includes(`--${name}`);

const NUM_SESSIONS = parseInt(getArg("sessions", "5"), 10);
const OUTPUT_JSON = hasFlag("json");
const OUTPUT_TSV = hasFlag("tsv-row");
const OUTPUT_DIAGNOSTICS = hasFlag("diagnostics");
const AGENT_FILTER = getArg("agent", "all");

// ---------------------------------------------------------------------------
// Session loading
// ---------------------------------------------------------------------------

function getSessionFiles(agentId: AgentId, n: number): string[] {
  const dir = join(SESSIONS_BASE, agentId, "sessions");
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({
      path: join(dir, f),
      mtime: statSync(join(dir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, n * 2); // grab extra to account for skipped sessions

  return files.map((f) => f.path);
}

function parseSession(filepath: string): SessionEntry[] {
  const raw = readFileSync(filepath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.trim());
  const entries: SessionEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function getMessages(entries: SessionEntry[]): { role: string; content: ContentItem[] }[] {
  return entries.filter((e) => e.type === "message" && e.message).map((e) => e.message!);
}

function isHeartbeatOnly(entries: SessionEntry[]): boolean {
  const msgs = getMessages(entries);
  const assistantTexts = msgs
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.content.filter((c) => c.type === "text"))
    .map((c) => c.text?.trim() || "");
  return (
    assistantTexts.length > 0 &&
    assistantTexts.every((t) => t === "HEARTBEAT_OK" || t.startsWith("HEARTBEAT"))
  );
}

function loadValidSessions(agentId: AgentId, n: number, minMessages: number): SessionEntry[][] {
  const files = getSessionFiles(agentId, n);
  const valid: SessionEntry[][] = [];

  for (const f of files) {
    if (valid.length >= n) break;
    const entries = parseSession(f);
    const msgs = getMessages(entries);
    if (msgs.length < minMessages) continue;
    if (agentId === "main" && isHeartbeatOnly(entries)) continue;
    valid.push(entries);
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Metric 1: Delegation Ratio
// ---------------------------------------------------------------------------

const DIRECT_TOOLS = new Set(["exec", "mcp_search", "web_search", "web_fetch"]);
const DELEGATION_TOOLS = new Set(["sessions_spawn", "message"]);

function scoreDelegation(sessions: SessionEntry[][]): number {
  let directCount = 0;
  let delegationCount = 0;

  for (const entries of sessions) {
    const msgs = getMessages(entries);
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue;
      for (const item of msg.content) {
        if (item.type !== "toolCall" || !item.name) continue;
        if (DIRECT_TOOLS.has(item.name)) directCount++;
        if (DELEGATION_TOOLS.has(item.name)) delegationCount++;
      }
    }
  }

  const total = directCount + delegationCount;
  if (total === 0) return 0.5;
  return delegationCount / total;
}

// ---------------------------------------------------------------------------
// Metric 2: Memory Usage Rate
// ---------------------------------------------------------------------------

function scoreMemory(sessions: SessionEntry[][]): number {
  let contextMessages = 0;
  let memorySearches = 0;

  for (const entries of sessions) {
    const msgs = getMessages(entries);
    for (const msg of msgs) {
      if (msg.role === "user") {
        const texts = msg.content.filter((c) => c.type === "text").map((c) => c.text || "");
        for (const t of texts) {
          if (CONTEXT_TRIGGER.test(t)) contextMessages++;
        }
      }
      if (msg.role === "assistant") {
        for (const item of msg.content) {
          if (item.type === "toolCall" && item.name === "memory_search") memorySearches++;
        }
      }
    }
  }

  if (contextMessages === 0) return 1.0;
  return Math.min(memorySearches / contextMessages, 1.0);
}

// ---------------------------------------------------------------------------
// Metric 3: Conciseness
// ---------------------------------------------------------------------------

function scoreConciseness(sessions: SessionEntry[][]): number {
  const wordCounts: number[] = [];

  for (const entries of sessions) {
    const msgs = getMessages(entries);
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue;
      for (const item of msg.content) {
        if (item.type !== "text" || !item.text) continue;
        const text = item.text.trim();
        // Skip multi-part responses (tables, code blocks, long lists)
        if (
          text.includes("|") &&
          text.includes("---") // table
        )
          continue;
        if ((text.match(/```/g) || []).length >= 2) continue; // code block
        if ((text.match(/^[-*]\s/gm) || []).length > 5) continue; // long list

        const words = text.split(/\s+/).filter((w) => w.length > 0).length;
        if (words > 0) wordCounts.push(words);
      }
    }
  }

  if (wordCounts.length === 0) return 1.0;
  const avg = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;

  if (avg <= 50) return 1.0;
  if (avg <= 100) return 0.8;
  if (avg <= 150) return 0.6;
  if (avg <= 200) return 0.4;
  return 0.2;
}

// ---------------------------------------------------------------------------
// Metric 4: Silent Reply Accuracy
// ---------------------------------------------------------------------------

function scoreSilentReply(sessions: SessionEntry[][]): number {
  // This metric checks if the agent correctly responds NO_REPLY
  // to off-channel messages. Off-channel detection requires session header
  // context which varies by setup. For now, we check for NO_REPLY usage
  // in sessions that have system/cron messages.
  let offChannelMessages = 0;
  let correctSilent = 0;

  for (const entries of sessions) {
    const msgs = getMessages(entries);
    for (let i = 0; i < msgs.length; i++) {
      const msg = msgs[i];
      if (msg.role !== "user") continue;

      const userText = msg.content
        .filter((c) => c.type === "text")
        .map((c) => c.text || "")
        .join("");

      // Detect off-channel: messages from other topics/channels
      // indicated by topic markers or channel headers in the text
      const isOffChannel =
        userText.includes("[Off-channel]") ||
        userText.includes("[Different topic]") ||
        (userText.includes("topic-") &&
          entries[0] &&
          !JSON.stringify(entries[0]).includes(userText.match(/topic-\d+/)?.[0] || "---"));

      if (!isOffChannel) continue;
      offChannelMessages++;

      // Check next assistant response
      const nextAssistant = msgs.slice(i + 1).find((m) => m.role === "assistant");
      if (nextAssistant) {
        const responseText = nextAssistant.content
          .filter((c) => c.type === "text")
          .map((c) => c.text?.trim() || "")
          .join("");
        if (responseText === "NO_REPLY") correctSilent++;
      }
    }
  }

  if (offChannelMessages === 0) return 1.0;
  return correctSilent / offChannelMessages;
}

// ---------------------------------------------------------------------------
// Metric 5: Tool Error Rate
// ---------------------------------------------------------------------------

function scoreToolErrors(sessions: SessionEntry[][]): number {
  let totalCalls = 0;
  let errors = 0;

  for (const entries of sessions) {
    const msgs = getMessages(entries);
    for (const msg of msgs) {
      if (msg.role === "assistant") {
        for (const item of msg.content) {
          if (item.type === "toolCall") totalCalls++;
        }
      }
      // toolResult can appear as a separate message or inline
      if (msg.role === "toolResult" || msg.role === "assistant") {
        for (const item of msg.content) {
          if (item.type === "toolResult") {
            if (item.isError === true || item.is_error === true) errors++;
          }
        }
      }
    }
    // Also check top-level toolResult messages
    for (const entry of entries) {
      if (entry.type === "message" && entry.message?.role === "toolResult") {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          // already handled above
        } else if (typeof content === "object" && content !== null) {
          // single toolResult entry at message level
          const isErr = (entry.message as Record<string, unknown>).isError === true;
          if (isErr) errors++;
        }
      }
    }
  }

  if (totalCalls === 0) return 1.0;
  return 1.0 - errors / totalCalls;
}

// ---------------------------------------------------------------------------
// Metric 6: Tool Execution Rate (subagents)
// ---------------------------------------------------------------------------

function scoreToolExecRate(sessions: SessionEntry[][]): number {
  let realToolCalls = 0;
  let textToolEchoes = 0;

  const toolEchoPattern =
    /(?:exec:\s*\{|"cmd"|"tool"\s*:\s*"exec"|```bash\s*\n\s*(?:ls|cd|cat|grep|find|mkdir|rm|mv|cp|echo|npm|pnpm|bun|git)\b)/;

  for (const entries of sessions) {
    const msgs = getMessages(entries);
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue;
      for (const item of msg.content) {
        if (item.type === "toolCall") {
          realToolCalls++;
        } else if (item.type === "text" && item.text) {
          if (toolEchoPattern.test(item.text)) {
            textToolEchoes++;
          }
        }
      }
    }
  }

  const total = realToolCalls + textToolEchoes;
  if (total === 0) return 1.0;
  return realToolCalls / total;
}

// ---------------------------------------------------------------------------
// Metric 7: Memory Write-Back Rate
// ---------------------------------------------------------------------------

function scoreWriteBack(sessions: SessionEntry[][]): number {
  let qualifyingSessions = 0;
  let sessionsWithWrite = 0;

  for (const entries of sessions) {
    const msgs = getMessages(entries);
    if (msgs.length < 5) continue;
    qualifyingSessions++;

    let hasWrite = false;
    for (const msg of msgs) {
      if (msg.role !== "assistant") continue;
      for (const item of msg.content) {
        if (item.type !== "toolCall") continue;
        if (item.name !== "write" && item.name !== "edit") continue;
        const path = String(item.arguments?.path || item.arguments?.file_path || "");
        if (path.includes("memory/") || path.includes("MEMORY.md")) {
          hasWrite = true;
        }
      }
    }
    if (hasWrite) sessionsWithWrite++;
  }

  if (qualifyingSessions === 0) return -1; // no data
  return sessionsWithWrite / qualifyingSessions;
}

// ---------------------------------------------------------------------------
// Metric 9: Memory Richness
// ---------------------------------------------------------------------------

function scoreMemoryRichness(agentId: AgentId): number {
  const workspace = join(WORKSPACES_BASE, AGENT_WORKSPACE_MAP[agentId]);
  const memoryMd = join(workspace, "MEMORY.md");
  const memoryDir = join(workspace, "memory");

  let wordCount = 0;
  if (existsSync(memoryMd)) {
    const content = readFileSync(memoryMd, "utf-8");
    wordCount = content.split(/\s+/).filter((w) => w.length > 0).length;
  }

  let dailyNoteCount = 0;
  if (existsSync(memoryDir)) {
    dailyNoteCount = readdirSync(memoryDir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).length;
  }

  const richness =
    (Math.min(wordCount, 200) / 200) * 0.5 + (Math.min(dailyNoteCount, 10) / 10) * 0.5;
  return richness;
}

// ---------------------------------------------------------------------------
// Platform Diagnostics
// ---------------------------------------------------------------------------

interface PlatformIssue {
  category: string;
  severity: "high" | "medium" | "low";
  agent: AgentId;
  session_id: string;
  timestamp: string;
  tool_name: string;
  error_signature: string;
  evidence: string;
  suggested_labels: string[];
}

function detectPlatformIssues(): PlatformIssue[] {
  const issues: PlatformIssue[] = [];
  const seen = new Set<string>(); // dedup by error_signature

  for (const agentId of AGENTS) {
    const minMessages = agentId === "main" ? 3 : 2;
    const sessions = loadValidSessions(agentId, NUM_SESSIONS * 2, minMessages);

    for (const entries of sessions) {
      const sessionHeader = entries.find((e) => e.type === "session");
      const sessionId = (sessionHeader?.id as string) || "unknown";
      const sessionTimestamp = (sessionHeader?.timestamp as string) || new Date().toISOString();
      const msgs = getMessages(entries);

      // Check for tool errors with details
      for (const msg of msgs) {
        if (msg.role === "assistant") {
          for (const item of msg.content) {
            if (item.type !== "toolCall") continue;
            const toolName = item.name || "unknown";
            const toolCallId = item.id || "";

            // Find matching toolResult
            for (const resultMsg of msgs) {
              for (const resultItem of resultMsg.content) {
                if (resultItem.type !== "toolResult") continue;
                if (resultItem.toolCallId !== toolCallId && resultItem.id !== toolCallId) continue;
                if (resultItem.isError !== true && resultItem.is_error !== true) continue;

                const errorText =
                  typeof resultItem.content === "string"
                    ? resultItem.content
                    : typeof resultItem.text === "string"
                      ? resultItem.text
                      : JSON.stringify(resultItem.content || "").slice(0, 500);

                // Classify the error
                const classification = classifyError(toolName, errorText);
                if (!classification) continue;

                const sig = `${classification.category}:${toolName}:${classification.signature}`;
                if (seen.has(sig)) continue;
                seen.add(sig);

                issues.push({
                  category: classification.category,
                  severity: classification.severity,
                  agent: agentId,
                  session_id: sessionId,
                  timestamp: sessionTimestamp,
                  tool_name: toolName,
                  error_signature: sig,
                  evidence: errorText.slice(0, 300),
                  suggested_labels: ["auto-improve", "platform", classification.category],
                });
              }
            }
          }
        }
      }

      // Check for session aborts
      for (const entry of entries) {
        if (
          entry.type === "custom" &&
          (entry as Record<string, unknown>).customType === "openclaw:prompt-error"
        ) {
          const data = (entry as Record<string, unknown>).data as
            | Record<string, unknown>
            | undefined;
          const errorMsg = String(data?.error || "unknown");
          const sig = `session-abort:${agentId}:${errorMsg}`;
          if (seen.has(sig)) continue;
          seen.add(sig);

          issues.push({
            category: "session-stability",
            severity: errorMsg === "aborted" ? "low" : "high",
            agent: agentId,
            session_id: sessionId,
            timestamp: (entry.timestamp as string) || sessionTimestamp,
            tool_name: "session",
            error_signature: sig,
            evidence: `Session prompt error: ${errorMsg} (provider: ${data?.provider}, model: ${data?.model})`,
            suggested_labels: ["auto-improve", "platform", "session-stability"],
          });
        }
      }

      // Check for tool execution failures (text echoes in subagents)
      if (agentId !== "main") {
        let textEchoes = 0;
        let realCalls = 0;
        for (const msg of msgs) {
          if (msg.role !== "assistant") continue;
          for (const item of msg.content) {
            if (item.type === "toolCall") realCalls++;
            if (
              item.type === "text" &&
              item.text &&
              /(?:exec:\s*\{|"cmd"|"tool"\s*:\s*"exec")/.test(item.text)
            ) {
              textEchoes++;
            }
          }
        }
        const total = realCalls + textEchoes;
        if (total > 0 && realCalls / total < 0.3) {
          const sig = `tool-pipeline:${agentId}:exec-rate-${(realCalls / total).toFixed(2)}`;
          if (!seen.has(sig)) {
            seen.add(sig);
            issues.push({
              category: "tool-pipeline",
              severity: "high",
              agent: agentId,
              session_id: sessionId,
              timestamp: sessionTimestamp,
              tool_name: "tool-pipeline",
              error_signature: sig,
              evidence: `Agent ${agentId} tool execution rate: ${(realCalls / total).toFixed(2)} (${realCalls} real / ${textEchoes} echoed). Agent is echoing tool syntax as text instead of invoking tools.`,
              suggested_labels: ["auto-improve", "platform", "tool-pipeline"],
            });
          }
        }
      }
    }
  }

  return issues;
}

function classifyError(
  toolName: string,
  errorText: string,
): { category: string; severity: "high" | "medium" | "low"; signature: string } | null {
  const lower = errorText.toLowerCase();

  // Timeouts
  if (lower.includes("timeout") || lower.includes("timed out") || lower.includes("etimedout")) {
    return { category: "tool-timeout", severity: "high", signature: `timeout:${toolName}` };
  }

  // MCP server issues
  if (
    lower.includes("mcp") ||
    lower.includes("server not found") ||
    lower.includes("connection refused") ||
    lower.includes("econnrefused") ||
    toolName.startsWith("mcp_")
  ) {
    return { category: "mcp-integration", severity: "high", signature: `mcp:${toolName}` };
  }

  // RPC / gateway errors
  if (lower.includes("rpc") || lower.includes("500") || lower.includes("internal server error")) {
    return { category: "gateway-rpc", severity: "high", signature: `rpc:${toolName}` };
  }

  // Permission / auth
  if (lower.includes("permission") || lower.includes("unauthorized") || lower.includes("403")) {
    return { category: "auth", severity: "medium", signature: `auth:${toolName}` };
  }

  // Not found / missing
  if (lower.includes("not found") || lower.includes("404") || lower.includes("no such file")) {
    return { category: "missing-resource", severity: "low", signature: `notfound:${toolName}` };
  }

  // Schema / validation
  if (lower.includes("schema") || lower.includes("validation") || lower.includes("invalid")) {
    return { category: "schema-validation", severity: "medium", signature: `schema:${toolName}` };
  }

  // Generic tool error — only flag if high frequency
  return null;
}

// ---------------------------------------------------------------------------
// Score an agent
// ---------------------------------------------------------------------------

function scoreAgent(agentId: AgentId): AgentScores {
  const minMessages = agentId === "main" ? 3 : 2;
  const sessions = loadValidSessions(agentId, NUM_SESSIONS, minMessages);

  const delegation = agentId === "main" ? scoreDelegation(sessions) : -1;
  const memory = scoreMemory(sessions);
  const conciseness = agentId === "main" ? scoreConciseness(sessions) : -1;
  const silent_reply = agentId === "main" ? scoreSilentReply(sessions) : -1;
  const error_rate = scoreToolErrors(sessions);
  const tool_exec_rate = scoreToolExecRate(sessions);
  const memory_writeback = scoreWriteBack(sessions);
  const memory_richness = scoreMemoryRichness(agentId);

  // Composite (Operator1 only)
  let composite = -1;
  if (agentId === "main") {
    composite =
      delegation * WEIGHTS.delegation +
      memory * WEIGHTS.memory +
      conciseness * WEIGHTS.conciseness +
      silent_reply * WEIGHTS.silent_reply +
      error_rate * WEIGHTS.error_rate;
  }

  return {
    agent: agentId,
    sessions_analyzed: sessions.length,
    delegation,
    memory,
    conciseness,
    silent_reply,
    error_rate,
    composite,
    tool_exec_rate,
    memory_writeback,
    memory_richness,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function fmt(n: number, decimals = 3): string {
  if (n === -1) return "-";
  return n.toFixed(decimals);
}

function printTable(results: AgentScores[]) {
  const main = results.find((r) => r.agent === "main");
  const subs = results.filter((r) => r.agent !== "main");

  if (main) {
    console.log("=== Operator1 (main) ===");
    console.log(`Sessions analyzed: ${main.sessions_analyzed}`);
    console.log("");
    console.log("  Composite Score:    " + fmt(main.composite));
    console.log("");
    console.log("  Metrics (in composite):");
    console.log(`    Delegation:       ${fmt(main.delegation)}  (weight: 0.30)`);
    console.log(`    Memory:           ${fmt(main.memory)}  (weight: 0.20)`);
    console.log(`    Conciseness:      ${fmt(main.conciseness)}  (weight: 0.15)`);
    console.log(`    Silent Reply:     ${fmt(main.silent_reply)}  (weight: 0.15)`);
    console.log(`    Tool Errors:      ${fmt(main.error_rate)}  (weight: 0.20)`);
    console.log("");
    console.log("  Diagnostics:");
    console.log(`    Tool Exec Rate:   ${fmt(main.tool_exec_rate)}`);
    console.log(`    Memory Write-Back:${fmt(main.memory_writeback)}`);
    console.log(`    Memory Richness:  ${fmt(main.memory_richness)}`);
    console.log("");
  }

  if (subs.length > 0) {
    console.log("=== Subagents ===");
    console.log(
      "Agent".padEnd(12) +
        "Sessions".padEnd(10) +
        "ExecRate".padEnd(10) +
        "WriteBack".padEnd(11) +
        "Richness".padEnd(10) +
        "Memory".padEnd(10) +
        "Errors",
    );
    console.log("-".repeat(63));
    for (const s of subs) {
      console.log(
        s.agent.padEnd(12) +
          String(s.sessions_analyzed).padEnd(10) +
          fmt(s.tool_exec_rate).padEnd(10) +
          fmt(s.memory_writeback).padEnd(11) +
          fmt(s.memory_richness).padEnd(10) +
          fmt(s.memory).padEnd(10) +
          fmt(s.error_rate),
      );
    }
    console.log("");
  }
}

function printTsvRow(results: AgentScores[]) {
  const main = results.find((r) => r.agent === "main");
  const neo = results.find((r) => r.agent === "neo");
  const morpheus = results.find((r) => r.agent === "morpheus");
  const trinity = results.find((r) => r.agent === "trinity");

  if (!main) {
    console.error("No main agent scores available for TSV row");
    process.exit(1);
  }

  // Format: commit score delegation memory conciseness silent_reply error_rate
  //         neo_exec morpheus_exec trinity_exec
  //         op1_wb neo_wb morpheus_wb trinity_wb
  //         op1_rich neo_rich morpheus_rich trinity_rich
  //         status description
  const cols = [
    "pending", // commit — agent fills this after committing
    fmt(main.composite),
    fmt(main.delegation),
    fmt(main.memory),
    fmt(main.conciseness),
    fmt(main.silent_reply),
    fmt(main.error_rate),
    fmt(neo?.tool_exec_rate ?? -1),
    fmt(morpheus?.tool_exec_rate ?? -1),
    fmt(trinity?.tool_exec_rate ?? -1),
    fmt(main.memory_writeback),
    fmt(neo?.memory_writeback ?? -1),
    fmt(morpheus?.memory_writeback ?? -1),
    fmt(trinity?.memory_writeback ?? -1),
    fmt(main.memory_richness),
    fmt(neo?.memory_richness ?? -1),
    fmt(morpheus?.memory_richness ?? -1),
    fmt(trinity?.memory_richness ?? -1),
    "pending", // status — agent fills this
    "pending", // description — agent fills this
  ];

  console.log(cols.join("\t"));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const agentsToScore: AgentId[] = AGENT_FILTER === "all" ? [...AGENTS] : [AGENT_FILTER as AgentId];

  if (!AGENTS.includes(agentsToScore[0] as AgentId)) {
    console.error(`Unknown agent: ${AGENT_FILTER}. Valid: ${AGENTS.join(", ")}, all`);
    process.exit(1);
  }

  const results = agentsToScore.map(scoreAgent);

  if (OUTPUT_DIAGNOSTICS) {
    const issues = detectPlatformIssues();
    console.log(JSON.stringify(issues, null, 2));
  } else if (OUTPUT_JSON) {
    console.log(JSON.stringify(results, null, 2));
  } else if (OUTPUT_TSV) {
    const allResults = AGENT_FILTER === "all" ? results : AGENTS.map(scoreAgent);
    printTsvRow(allResults);
  } else {
    printTable(results);
  }
}

main();

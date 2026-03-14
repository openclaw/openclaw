/**
 * CLI trace viewer — pure functions that return string[] lines.
 *
 * Ported from demo-tracing/viewer.ts.
 */

import type { TraceSpan } from "./types.js";

// ── ANSI colors ──
const c = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
};

const kindColor: Record<string, string> = {
  session: c.cyan,
  llm_call: c.yellow,
  tool_call: c.green,
  subagent: c.magenta,
};

const kindIcon: Record<string, string> = {
  session: "\u{1f535}",
  llm_call: "\u{1f9e0}",
  tool_call: "\u{1f527}",
  subagent: "\u{1f916}",
};

function fmtDuration(ms?: number): string {
  if (ms === undefined) return "";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(span: TraceSpan): string {
  if (span.kind !== "llm_call") return "";
  const parts: string[] = [];
  if (span.tokensIn) parts.push(`in:${span.tokensIn}`);
  if (span.tokensOut) parts.push(`out:${span.tokensOut}`);
  return parts.length ? `${c.dim}[${parts.join(" ")}]${c.reset}` : "";
}

/**
 * Render a nested call tree by parentSpanId, sorted by startMs.
 */
export function renderCallTree(spans: TraceSpan[]): string[] {
  if (spans.length === 0) return [];

  const lines: string[] = [];

  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (span.parentSpanId) {
      const list = children.get(span.parentSpanId) ?? [];
      list.push(span);
      children.set(span.parentSpanId, list);
    }
  }

  // Sort children by startMs
  for (const [, list] of children) {
    list.sort((a, b) => a.startMs - b.startMs);
  }

  const roots = spans.filter((s) => !s.parentSpanId).sort((a, b) => a.startMs - b.startMs);

  function printSpan(span: TraceSpan, prefix: string, isLast: boolean) {
    const connector = isLast ? "\u2514\u2500" : "\u251c\u2500";
    const icon = kindIcon[span.kind] ?? "\u25cf";
    const color = kindColor[span.kind] ?? c.white;
    const dur = fmtDuration(span.durationMs);
    const tokens = fmtTokens(span);

    let label = "";
    switch (span.kind) {
      case "session":
        label = `${color}${span.agentId}${c.reset} ${c.dim}(${span.sessionKey})${c.reset}`;
        break;
      case "llm_call":
        label = `${color}llm${c.reset} ${c.dim}[${span.provider}/${span.model}]${c.reset}`;
        break;
      case "tool_call":
        label = `${color}${span.toolName ?? span.name}${c.reset}`;
        if (span.toolParams) {
          const preview = Object.entries(span.toolParams)
            .map(([k, v]) => {
              const str = typeof v === "string" ? v : JSON.stringify(v);
              return `${k}=${str.length > 30 ? str.slice(0, 30) + "\u2026" : str}`;
            })
            .join(", ");
          label += ` ${c.dim}(${preview})${c.reset}`;
        }
        break;
      case "subagent":
        label = `${color}\u2192 ${span.childAgentId}${c.reset} ${c.dim}(${span.childSessionKey})${c.reset}`;
        break;
    }

    const durStr = dur ? ` ${c.blue}${dur}${c.reset}` : "";
    const tokensStr = tokens ? ` ${tokens}` : "";
    lines.push(`${prefix}${connector} ${icon} ${label}${durStr}${tokensStr}`);

    const kids = children.get(span.spanId) ?? [];
    const childPrefix = prefix + (isLast ? "   " : "\u2502  ");
    kids.forEach((child, i) => {
      printSpan(child, childPrefix, i === kids.length - 1);
    });
  }

  roots.forEach((root, i) => {
    printSpan(root, "", i === roots.length - 1);
  });

  return lines;
}

/**
 * Render an agent relationship tree with aggregated stats.
 */
export function renderEntityTree(spans: TraceSpan[]): string[] {
  if (spans.length === 0) return [];

  const lines: string[] = [];

  type AgentNode = {
    agentId: string;
    sessionKey?: string;
    children: AgentNode[];
    toolsUsed: string[];
    models: string[];
    totalDurationMs: number;
    totalTokensIn: number;
    totalTokensOut: number;
    llmCallCount: number;
    toolCallCount: number;
  };

  const agentNodes = new Map<string, AgentNode>();

  for (const span of spans) {
    if (!span.agentId) continue;
    if (!agentNodes.has(span.agentId)) {
      agentNodes.set(span.agentId, {
        agentId: span.agentId,
        sessionKey: span.kind === "session" ? span.sessionKey : undefined,
        children: [],
        toolsUsed: [],
        models: [],
        totalDurationMs: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        llmCallCount: 0,
        toolCallCount: 0,
      });
    }
    const node = agentNodes.get(span.agentId)!;
    if (span.kind === "session") {
      node.sessionKey = span.sessionKey;
      node.totalDurationMs = span.durationMs ?? 0;
    }
    if (span.kind === "llm_call") {
      node.llmCallCount++;
      node.totalTokensIn += span.tokensIn ?? 0;
      node.totalTokensOut += span.tokensOut ?? 0;
      if (span.model && !node.models.includes(span.model)) {
        node.models.push(span.model);
      }
    }
    if (span.kind === "tool_call" && span.toolName) {
      node.toolCallCount++;
      if (!node.toolsUsed.includes(span.toolName)) {
        node.toolsUsed.push(span.toolName);
      }
    }
  }

  // Build parent->child edges
  const childAgents = new Set<string>();
  for (const span of spans) {
    if (span.kind === "subagent" && span.agentId && span.childAgentId) {
      const parent = agentNodes.get(span.agentId);
      const child = agentNodes.get(span.childAgentId);
      if (parent && child) {
        parent.children.push(child);
        childAgents.add(span.childAgentId);
      }
    }
  }

  const rootAgents = [...agentNodes.values()].filter((n) => !childAgents.has(n.agentId));

  function printAgent(node: AgentNode, prefix: string, isLast: boolean) {
    const connector = isLast ? "\u2514\u2500" : "\u251c\u2500";
    const name = `${c.bold}${c.cyan}${node.agentId}${c.reset}`;
    const session = node.sessionKey ? ` ${c.dim}(${node.sessionKey})${c.reset}` : "";
    const dur = node.totalDurationMs
      ? ` ${c.blue}${fmtDuration(node.totalDurationMs)}${c.reset}`
      : "";
    lines.push(`${prefix}${connector} \u{1f916} ${name}${session}${dur}`);

    const detailPrefix = prefix + (isLast ? "   " : "\u2502  ");

    // Stats line
    const stats: string[] = [];
    if (node.llmCallCount) stats.push(`${c.yellow}${node.llmCallCount} LLM calls${c.reset}`);
    if (node.toolCallCount) stats.push(`${c.green}${node.toolCallCount} tool calls${c.reset}`);
    if (node.totalTokensIn || node.totalTokensOut) {
      stats.push(`${c.dim}tokens: ${node.totalTokensIn}\u2192${node.totalTokensOut}${c.reset}`);
    }
    if (stats.length) {
      lines.push(`${detailPrefix}${c.dim}\u2502${c.reset} ${stats.join("  ")}`);
    }

    // Models
    if (node.models.length) {
      lines.push(
        `${detailPrefix}${c.dim}\u2502${c.reset} models: ${c.yellow}${node.models.join(", ")}${c.reset}`,
      );
    }

    // Tools
    if (node.toolsUsed.length) {
      lines.push(
        `${detailPrefix}${c.dim}\u2502${c.reset} tools: ${c.green}${node.toolsUsed.join(", ")}${c.reset}`,
      );
    }

    // Children
    if (node.children.length) {
      lines.push(`${detailPrefix}${c.dim}\u2502${c.reset}`);
      node.children.forEach((child, i) => {
        printAgent(child, detailPrefix, i === node.children.length - 1);
      });
    }
  }

  rootAgents.forEach((root, i) => {
    printAgent(root, "", i === rootAgents.length - 1);
  });

  // Summary
  lines.push("");
  const totalAgents = agentNodes.size;
  const totalLlm = spans.filter((s) => s.kind === "llm_call").length;
  const totalTools = spans.filter((s) => s.kind === "tool_call").length;
  const totalTokens = spans.reduce((sum, s) => sum + (s.tokensIn ?? 0) + (s.tokensOut ?? 0), 0);
  lines.push(`${c.dim}\u2500\u2500\u2500 Summary \u2500\u2500\u2500${c.reset}`);
  lines.push(
    `  Agents: ${c.bold}${totalAgents}${c.reset}  LLM calls: ${c.bold}${totalLlm}${c.reset}  Tool calls: ${c.bold}${totalTools}${c.reset}  Total tokens: ${c.bold}${totalTokens}${c.reset}`,
  );

  return lines;
}

/**
 * Render a waterfall timeline bar chart.
 */
export function renderWaterfall(spans: TraceSpan[]): string[] {
  if (spans.length === 0) return [];

  const lines: string[] = [];
  const barWidth = 60;

  const minStart = Math.min(...spans.map((s) => s.startMs));
  const maxEnd = Math.max(...spans.map((s) => s.endMs ?? s.startMs));
  const totalDuration = maxEnd - minStart;

  // Sort by startMs, then by kind priority
  const kindOrder: Record<string, number> = { session: 0, llm_call: 1, tool_call: 2, subagent: 1 };
  const sorted = [...spans].sort((a, b) => {
    if (a.startMs !== b.startMs) return a.startMs - b.startMs;
    return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
  });

  for (const span of sorted) {
    const relStart = span.startMs - minStart;
    const dur = (span.endMs ?? span.startMs) - span.startMs;
    const barStart = Math.round((relStart / totalDuration) * barWidth);
    const barLen = Math.max(1, Math.round((dur / totalDuration) * barWidth));

    const color = kindColor[span.kind] ?? c.white;
    const icon = kindIcon[span.kind] ?? "\u25cf";

    const label =
      span.kind === "llm_call"
        ? `llm [${span.model?.split("-").slice(0, 2).join("-") ?? "?"}]`
        : span.kind === "subagent"
          ? `\u2192${span.childAgentId}`
          : span.kind === "session"
            ? (span.agentId ?? span.name)
            : (span.toolName ?? span.name);

    const paddedLabel = (label + "                         ").slice(0, 25);
    const bar =
      " ".repeat(barStart) +
      "\u2588".repeat(barLen) +
      " ".repeat(Math.max(0, barWidth - barStart - barLen));
    const durStr = fmtDuration(span.durationMs);

    lines.push(
      `  ${icon} ${color}${paddedLabel}${c.reset} ${c.dim}\u2502${c.reset}${color}${bar}${c.reset}${c.dim}\u2502${c.reset} ${c.blue}${durStr}${c.reset}`,
    );
  }

  lines.push(
    `  ${"                            "}${c.dim}\u2502${"0".padEnd(barWidth / 2)}${fmtDuration(totalDuration)}\u2502${c.reset}`,
  );

  return lines;
}

/**
 * Execution health monitor — detects agent death spirals.
 *
 * Four detection patterns:
 * 1. file-burst:      too many file writes in a short window
 * 2. tool-repeat:     same tool+args called repeatedly
 * 3. no-effect-loop:  many turns without a "real" side-effect
 * 4. error-cascade:   consecutive tool errors
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractToolCallsFromAssistant, extractToolResultId } from "./tool-call-id.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionHealthSignalType =
  | "file-burst"
  | "tool-repeat"
  | "no-effect-loop"
  | "error-cascade";

export type ExecutionHealthSeverity = "info" | "warning" | "critical";

export type ExecutionHealthSignal = {
  type: ExecutionHealthSignalType;
  severity: ExecutionHealthSeverity;
  details: {
    windowMs: number;
    toolCallCount: number;
    uniqueEffects: number;
    fileCreations: number;
    repeatedTools: string[];
  };
  recommendation: string;
};

export type ExecutionHealthConfig = {
  enabled?: boolean;
  fileBurstThreshold?: number;
  fileBurstWindowMs?: number;
  toolRepeatThreshold?: number;
  toolRepeatWindowMs?: number;
  noEffectLoopThreshold?: number;
  errorCascadeThreshold?: number;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: Required<ExecutionHealthConfig> = {
  enabled: true,
  fileBurstThreshold: 10,
  fileBurstWindowMs: 600_000,
  toolRepeatThreshold: 5,
  toolRepeatWindowMs: 300_000,
  noEffectLoopThreshold: 10,
  errorCascadeThreshold: 3,
};

// Tools that are expected to be called repeatedly with the same args.
const REPEAT_IGNORE_TOOLS = new Set(["Read", "read", "memory_search", "MemorySearch"]);

// Tool names / shell commands that count as "real effects".
const EFFECT_TOOL_NAMES = new Set([
  "Bash",
  "bash",
  "computer",
  "execute_command",
  "run_terminal_command",
]);

const EFFECT_COMMAND_PATTERNS = [
  /\bgit\s+(commit|push|merge|rebase)\b/,
  /\bgh\s+(pr|issue)\b/,
  /\bcurl\s+-X\s+POST\b/,
  /\bnpm\s+publish\b/,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hashToolCall(name: string, args: unknown): string {
  try {
    return `${name}:${JSON.stringify(args)}`;
  } catch {
    return `${name}:<unstringifiable>`;
  }
}

type ToolCallEntry = {
  name: string;
  args: unknown;
  timestamp: number;
  isWrite: boolean;
  isError: boolean;
  isEffect: boolean;
};

function getMessageTimestamp(msg: AgentMessage, fallback: number): number {
  const value = (msg as { timestamp?: unknown }).timestamp;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isToolResultErrorMessage(msg: AgentMessage, toolUseId: string): boolean {
  if (msg.role === "toolResult") {
    return (
      extractToolResultId(msg) === toolUseId && Boolean((msg as { isError?: unknown }).isError)
    );
  }
  if (msg.role !== "user") {
    return false;
  }
  const resultContent = Array.isArray(msg.content) ? msg.content : [];
  return resultContent.some((rawRb) => {
    const rb = rawRb as Record<string, unknown>;
    return rb.type === "tool_result" && rb.tool_use_id === toolUseId && Boolean(rb.is_error);
  });
}

/**
 * Extract tool call metadata from a flat message array.
 * We pair assistant tool call blocks with their subsequent tool results.
 *
 * Note: this monitor reads persisted session transcripts, which currently keep
 * provider-native tool call blocks. `extractToolCallsFromAssistant` handles the
 * stored assistant shapes we persist today; normalized runner-only variants are
 * not expected in the JSONL history yet.
 */
function extractToolCalls(messages: AgentMessage[], afterIndex: number): ToolCallEntry[] {
  const entries: ToolCallEntry[] = [];

  for (let i = afterIndex; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "assistant") {
      continue;
    }

    const content = Array.isArray(msg.content) ? msg.content : [];
    const toolCalls = extractToolCallsFromAssistant(msg);
    if (toolCalls.length === 0) {
      continue;
    }

    const timestamp = getMessageTimestamp(msg, i);
    for (const toolCall of toolCalls) {
      const block = content.find((rawBlock) => {
        const rec = rawBlock as Record<string, unknown>;
        return rec && typeof rec === "object" && rec.id === toolCall.id;
      }) as Record<string, unknown> | undefined;
      if (!block) {
        continue;
      }

      const name = toolCall.name ?? "unknown";
      const args = block.input ?? block.arguments ?? block.args ?? {};

      let isError = false;
      for (let j = i + 1; j < messages.length && j <= i + 3; j++) {
        if (isToolResultErrorMessage(messages[j], toolCall.id)) {
          isError = true;
          break;
        }
      }

      const argsObj = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

      const isWrite =
        (name === "Write" ||
          name === "write" ||
          name === "write_to_file" ||
          name === "create_file") &&
        typeof argsObj.file_path === "string";

      let isEffect = false;
      if (EFFECT_TOOL_NAMES.has(name)) {
        const cmd = typeof argsObj.command === "string" ? argsObj.command : "";
        if (cmd) {
          isEffect = EFFECT_COMMAND_PATTERNS.some((re) => re.test(cmd));
        }
      }
      if (name.includes("send") || name.includes("Send") || name.includes("message")) {
        isEffect = true;
      }

      entries.push({
        name,
        args,
        timestamp,
        isWrite,
        isError,
        isEffect,
      });
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

export class ExecutionHealthMonitor {
  private readonly cfg: Required<ExecutionHealthConfig>;

  /** Running count of consecutive turns with no real effect. */
  private noEffectStreak = 0;

  /** Previous evaluation index so we only scan new messages. */
  private lastEvaluatedIndex = 0;

  constructor(config?: ExecutionHealthConfig) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Evaluate the current session messages and return any health signals.
   * Designed to be called after each turn.
   */
  evaluate(params: {
    messages: AgentMessage[];
    prePromptMessageCount: number;
  }): ExecutionHealthSignal[] {
    if (!this.cfg.enabled) {
      return [];
    }

    const { messages, prePromptMessageCount } = params;
    const startIndex = Math.max(prePromptMessageCount, this.lastEvaluatedIndex);
    const toolCalls = extractToolCalls(messages, startIndex);
    this.lastEvaluatedIndex = messages.length;

    const signals: ExecutionHealthSignal[] = [];

    // No-effect loop tracks turns even when no new tool calls are found
    // (a turn with zero tools is still a turn without a real effect).
    const noEffectSignal = this.detectNoEffectLoop(toolCalls);
    if (noEffectSignal) {
      signals.push(noEffectSignal);
    }

    if (toolCalls.length === 0) {
      return signals;
    }

    // Pattern 1: File burst
    const fileBurstSignal = this.detectFileBurst(toolCalls);
    if (fileBurstSignal) {
      signals.push(fileBurstSignal);
    }

    // Pattern 2: Tool repeat
    const toolRepeatSignal = this.detectToolRepeat(toolCalls, messages, prePromptMessageCount);
    if (toolRepeatSignal) {
      signals.push(toolRepeatSignal);
    }

    // Pattern 4: Error cascade
    const errorCascadeSignal = this.detectErrorCascade(toolCalls, messages, prePromptMessageCount);
    if (errorCascadeSignal) {
      signals.push(errorCascadeSignal);
    }

    return signals;
  }

  /** Reset internal state (e.g. between sessions). */
  reset(): void {
    this.noEffectStreak = 0;
    this.lastEvaluatedIndex = 0;
  }

  // -------------------------------------------------------------------------
  // Pattern detectors
  // -------------------------------------------------------------------------

  private detectFileBurst(toolCalls: ToolCallEntry[]): ExecutionHealthSignal | undefined {
    const writes = toolCalls.filter((tc) => tc.isWrite);
    if (writes.length < this.cfg.fileBurstThreshold) {
      return undefined;
    }

    const severity: ExecutionHealthSeverity =
      writes.length >= this.cfg.fileBurstThreshold * 3 ? "critical" : "warning";

    return {
      type: "file-burst",
      severity,
      details: {
        windowMs: this.cfg.fileBurstWindowMs,
        toolCallCount: toolCalls.length,
        uniqueEffects: toolCalls.filter((tc) => tc.isEffect).length,
        fileCreations: writes.length,
        repeatedTools: [],
      },
      recommendation: `${writes.length} file writes detected in a single evaluation window (threshold: ${this.cfg.fileBurstThreshold}). The agent may be creating artifacts instead of executing real work.`,
    };
  }

  private detectToolRepeat(
    newCalls: ToolCallEntry[],
    messages: AgentMessage[],
    prePromptMessageCount: number,
  ): ExecutionHealthSignal | undefined {
    // Collect all tool calls in the session (not just new ones) for repeat detection
    const allCalls = extractToolCalls(messages, prePromptMessageCount);
    const counts = new Map<string, number>();

    for (const tc of allCalls) {
      if (REPEAT_IGNORE_TOOLS.has(tc.name)) {
        continue;
      }
      const hash = hashToolCall(tc.name, tc.args);
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }

    const repeated: string[] = [];
    for (const [hash, count] of counts) {
      if (count >= this.cfg.toolRepeatThreshold) {
        repeated.push(hash.split(":")[0]);
      }
    }

    if (repeated.length === 0) {
      return undefined;
    }

    const maxCount = Math.max(...counts.values());
    const severity: ExecutionHealthSeverity =
      maxCount >= this.cfg.toolRepeatThreshold * 2 ? "critical" : "warning";

    return {
      type: "tool-repeat",
      severity,
      details: {
        windowMs: this.cfg.toolRepeatWindowMs,
        toolCallCount: allCalls.length,
        uniqueEffects: allCalls.filter((tc) => tc.isEffect).length,
        fileCreations: allCalls.filter((tc) => tc.isWrite).length,
        repeatedTools: [...new Set(repeated)],
      },
      recommendation: `Tools repeated ≥${this.cfg.toolRepeatThreshold} times with identical args: ${[...new Set(repeated)].join(", ")}. The agent may be stuck in a loop.`,
    };
  }

  private detectNoEffectLoop(toolCalls: ToolCallEntry[]): ExecutionHealthSignal | undefined {
    const hasEffect = toolCalls.some((tc) => tc.isEffect);
    if (hasEffect) {
      this.noEffectStreak = 0;
      return undefined;
    }

    this.noEffectStreak++;
    if (this.noEffectStreak < this.cfg.noEffectLoopThreshold) {
      return undefined;
    }

    const severity: ExecutionHealthSeverity =
      this.noEffectStreak >= this.cfg.noEffectLoopThreshold * 2 ? "critical" : "warning";

    return {
      type: "no-effect-loop",
      severity,
      details: {
        windowMs: 0,
        toolCallCount: toolCalls.length,
        uniqueEffects: 0,
        fileCreations: toolCalls.filter((tc) => tc.isWrite).length,
        repeatedTools: [],
      },
      recommendation: `${this.noEffectStreak} consecutive turns without a real side-effect (commit, push, send). The agent may be in a death spiral.`,
    };
  }

  private detectErrorCascade(
    _newCalls: ToolCallEntry[],
    messages: AgentMessage[],
    prePromptMessageCount: number,
  ): ExecutionHealthSignal | undefined {
    // Walk backwards from the end to count consecutive errored tool-result turns.
    let consecutiveErrors = 0;
    for (let i = messages.length - 1; i >= prePromptMessageCount; i--) {
      const msg = messages[i];

      let hasToolResult = false;
      let allErrors = false;

      if (msg.role === "toolResult") {
        hasToolResult = true;
        allErrors = Boolean((msg as { isError?: unknown }).isError);
      } else if (msg.role === "user") {
        const content = (Array.isArray(msg.content) ? msg.content : []) as unknown as Array<
          Record<string, unknown>
        >;
        const toolResults = content.filter((b) => b.type === "tool_result");
        hasToolResult = toolResults.length > 0;
        allErrors = hasToolResult && toolResults.every((b) => b.is_error);
      } else {
        continue;
      }

      if (!hasToolResult) {
        continue;
      }

      if (allErrors) {
        consecutiveErrors++;
      } else {
        break;
      }
    }

    if (consecutiveErrors < this.cfg.errorCascadeThreshold) {
      return undefined;
    }

    const severity: ExecutionHealthSeverity =
      consecutiveErrors >= this.cfg.errorCascadeThreshold * 2 ? "critical" : "warning";

    return {
      type: "error-cascade",
      severity,
      details: {
        windowMs: 0,
        toolCallCount: consecutiveErrors,
        uniqueEffects: 0,
        fileCreations: 0,
        repeatedTools: [],
      },
      recommendation: `${consecutiveErrors} consecutive tool calls returned errors. The agent may be hitting a persistent blocker (auth, rate limit, tool failure).`,
    };
  }
}

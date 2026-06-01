/**
 * context-capsule ContextEngine plugin for OpenClaw.
 *
 * Compresses session history before it reaches the LLM, achieving ~99% token
 * reduction while keeping a verbatim tail of recent messages for coherence.
 * Sessions under the minMessages threshold pass through unchanged.
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  AssembleResult,
  CompactResult,
  ContextEngine,
  ContextEngineInfo,
  IngestResult,
} from "openclaw/plugin-sdk/context-engine";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
// @ts-expect-error — external package, types may not be present at build time
import { compressContext, injectCapsule } from "@parad0x_labs/context-capsule";

// ---------------------------------------------------------------------------
// Configuration defaults
// ---------------------------------------------------------------------------

const DEFAULT_MIN_MESSAGES = 20;
const DEFAULT_KEEP_RECENT = 10;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type SimpleMessage = { role: string; content: string };

/**
 * Convert an OpenClaw AgentMessage to the plain {role, content} shape expected
 * by @parad0x_labs/context-capsule.
 *
 * Handles:
 *  - "toolResult" role → "tool"
 *  - Content that is already a string → used as-is
 *  - Content that is an array of content blocks → joined to a single string
 */
function normalizeMessages(messages: AgentMessage[]): SimpleMessage[] {
  return messages.map((msg) => {
    const role = msg.role === "toolResult" ? "tool" : (msg.role as string);

    let content: string;
    if (!("content" in msg) || (msg as { content: unknown }).content == null) {
      content = "";
    } else if (typeof (msg as { content: unknown }).content === "string") {
      content = (msg as { content: string }).content;
    } else if (Array.isArray((msg as { content: unknown[] }).content)) {
      const blocks = (msg as { content: unknown[] }).content;
      content = blocks
        .map((block) => {
          if (!block || typeof block !== "object") return "";
          const b = block as Record<string, unknown>;
          if (b.type === "text" && typeof b.text === "string") return b.text;
          if (b.type === "toolResult" || b.type === "tool_result") {
            const inner = b.content;
            if (typeof inner === "string") return inner;
            if (Array.isArray(inner)) {
              return (inner as unknown[])
                .map((ib) => {
                  if (!ib || typeof ib !== "object") return "";
                  const ibr = ib as Record<string, unknown>;
                  return ibr.type === "text" && typeof ibr.text === "string" ? ibr.text : "";
                })
                .filter(Boolean)
                .join("\n");
            }
            return "";
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    } else {
      content = "";
    }

    return { role, content };
  });
}

/** Rough token estimate: ~4 chars per token */
function estimateTokens(messages: AgentMessage[]): number {
  return messages.reduce((sum, m) => {
    const c =
      "content" in m && typeof (m as { content: unknown }).content === "string"
        ? ((m as { content: string }).content).length
        : 0;
    return sum + Math.ceil(c / 4);
  }, 0);
}

// ---------------------------------------------------------------------------
// ContextEngine implementation
// ---------------------------------------------------------------------------

type CapsuleConfig = {
  minMessages: number;
  keepRecentMessages: number;
};

class ContextCapsuleEngine implements ContextEngine {
  readonly info: ContextEngineInfo = {
    id: "context-capsule",
    name: "Context Capsule",
    version: "0.1.0",
    ownsCompaction: false,
    turnMaintenanceMode: "background",
  };

  private readonly cfg: CapsuleConfig;

  constructor(cfg: Partial<CapsuleConfig> = {}) {
    this.cfg = {
      minMessages: cfg.minMessages ?? DEFAULT_MIN_MESSAGES,
      keepRecentMessages: cfg.keepRecentMessages ?? DEFAULT_KEEP_RECENT,
    };
  }

  // Required: ingest — accept each message as the transcript grows
  async ingest(_params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult> {
    return { ingested: true };
  }

  // Required: assemble — build the context window for the next model call
  async assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number;
    availableTools?: Set<string>;
    model?: string;
    prompt?: string;
  }): Promise<AssembleResult> {
    const { messages } = params;

    // Short sessions: pass through unchanged
    if (messages.length < this.cfg.minMessages) {
      return {
        messages,
        estimatedTokens: estimateTokens(messages),
      };
    }

    // Compress the older history, keep the tail verbatim
    const tail = messages.slice(-this.cfg.keepRecentMessages);
    const older = messages.slice(0, -this.cfg.keepRecentMessages);
    const normalized = normalizeMessages(older);

    let summaryText: string;
    try {
      const capsule = await compressContext(normalized);
      const injected = await injectCapsule(capsule);
      summaryText = typeof injected === "string" ? injected : JSON.stringify(injected);
    } catch {
      // Fallback: skip compression, return original messages
      return {
        messages,
        estimatedTokens: estimateTokens(messages),
        promptAuthority: "preassembly_may_overflow",
      };
    }

    // Prepend capsule as a system context message
    const capsuleSystemMessage = {
      role: "system",
      content: `[Context Capsule — compressed history]\n${summaryText}`,
    } as unknown as AgentMessage;

    const assembled = [capsuleSystemMessage, ...tail];

    return {
      messages: assembled,
      estimatedTokens: estimateTokens(assembled),
      systemPromptAddition:
        "Earlier conversation history has been compressed into the context capsule above.",
    };
  }

  // Required: compact — delegate to runtime (engine does not own compaction)
  async compact(_params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string;
    runtimeContext?: unknown;
    abortSignal?: AbortSignal;
  }): Promise<CompactResult> {
    return {
      ok: true,
      compacted: false,
      reason: "delegated-to-runtime",
    };
  }
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export default definePluginEntry({
  id: "context-capsule",
  name: "Context Capsule",
  description:
    "99.3% token reduction on agent sessions via @parad0x_labs/context-capsule. " +
    "Works with Ollama, LM Studio, GPT-4, Mistral, and Claude. " +
    "Public benchmark with recovery-score gate in CI.",
  register(api) {
    api.registerContextEngine("context-capsule", (_ctx) => new ContextCapsuleEngine());
  },
});

import type { OpenVikingClient } from "./client.js";
import type { MemoryOpenVikingConfig } from "./config.js";
import {
  getCaptureDecision,
  extractNewTurnTexts,
} from "./text-utils.js";
import {
  trimForLog,
  toJsonLog,
} from "./memory-ranking.js";

// Simple in-memory lock to prevent concurrent commits
const commitLocks = new Set<string>();

type AgentMessage = {
  role?: string;
  content?: unknown;
};

type HookAgentContext = {
  sessionKey?: string;
  agentId?: string;
  sessionId?: string;
  messages?: AgentMessage[];
};

type AssembleResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
};

type IngestBatchResult = {
  ingestedCount: number;
};

type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
};

type RuntimeContext = {
  sessionKey?: string;
  agentId?: string;
};

type BeforePromptContext = {
  runtimeContext?: RuntimeContext;
  messages?: AgentMessage[];
};

type AfterTurnParams = {
  runtimeContext?: RuntimeContext;
  sessionId?: string;
  messages?: AgentMessage[];
  prePromptMessageCount?: number;
};

type CompactParams = {
  messages: AgentMessage[];
  tokenCount: number;
  tokenLimit: number;
};

export type MemoryOpenVikingContextEngine = {
  id: string;
  name: string;
  description: string;
  assemble: (params: { messages: AgentMessage[] }) => Promise<AssembleResult>;
  beforePromptBuild?: (params: BeforePromptContext) => Promise<{ messages: AgentMessage[] }>;
  afterTurn?: (params: AfterTurnParams) => Promise<void>;
  ingestBatch?: () => Promise<IngestBatchResult>;
  compact?: (params: CompactParams) => Promise<CompactResult>;
  resolveOVSession?: (sessionKey: string) => Promise<string>;
  commitOVSession?: (sessionKey: string) => Promise<void>;
};

function estimateTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const m of messages) {
    const content = typeof m.content === "string" ? m.content : "";
    total += Math.ceil(content.length / 4);
  }
  return total;
}

function resolveAgentId(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  const parts = sessionKey.split(":");
  return parts.length > 1 ? parts[1] : undefined;
}

function extractSessionKey(runtimeContext?: RuntimeContext): string | undefined {
  return runtimeContext?.sessionKey;
}

function warnOrInfo(logger: { warn: (msg: string) => void; info?: (msg: string) => void }, msg: string): void {
  if (logger.info) {
    logger.info(msg);
  } else {
    logger.warn(msg);
  }
}

export function createMemoryOpenVikingContextEngine(
  opts: {
    cfg: MemoryOpenVikingConfig;
    enabled?: boolean;
    logger: { warn: (msg: string) => void; info?: (msg: string) => void };
    getClient: () => Promise<OpenVikingClient>;
    resolveAgentId: (sessionId: string) => string;
  },
): MemoryOpenVikingContextEngine {
  const { cfg, logger, getClient, resolveAgentId } = opts;
  async function tryLegacyCompact(params: CompactParams): Promise<CompactResult | null> {
    return null;
  }

  const contextEnginePlugin: MemoryOpenVikingContextEngine = {
    id: "openviking",
    name: "OpenViking Context Engine",
    description: "OpenViking-backed context engine with auto-recall/capture",

    async assemble(assembleParams): Promise<AssembleResult> {
      return {
        messages: assembleParams.messages,
        estimatedTokens: estimateTokens(assembleParams.messages),
      };
    },

    async ingestBatch(): Promise<IngestBatchResult> {
      return { ingestedCount: 0 };
    },

    async afterTurn(afterTurnParams): Promise<void> {
      if (!cfg.autoCapture) {
        return;
      }

      const sessionKey = extractSessionKey(afterTurnParams.runtimeContext);
      const sessionId = sessionKey ?? afterTurnParams.sessionId;
      
      if (!sessionId) {
        warnOrInfo(logger, "openviking: auto-capture skipped (no session identifier)");
        return;
      }
      
      if (commitLocks.has(sessionId)) {
        warnOrInfo(logger, "openviking: auto-capture skipped (commit in progress for " + sessionId + ")");
        return;
      }
      commitLocks.add(sessionId);

      try {
        const agentId = resolveAgentId(sessionKey ?? afterTurnParams.sessionId);

        const messages = afterTurnParams.messages ?? [];
        if (messages.length === 0) {
          warnOrInfo(logger, "openviking: auto-capture skipped (messages=0)");
          return;
        }

        const start =
          typeof afterTurnParams.prePromptMessageCount === "number" &&
          afterTurnParams.prePromptMessageCount >= 0
            ? afterTurnParams.prePromptMessageCount
            : 0;

        const { texts: newTexts, newCount } = extractNewTurnTexts(messages, start);

        if (newTexts.length === 0) {
          warnOrInfo(logger, "openviking: auto-capture skipped (no new user/assistant messages)");
          return;
        }

        const turnText = newTexts.join("\n");
        const decision = getCaptureDecision(turnText, cfg.captureMode, cfg.captureMaxLength);
        const preview = turnText.length > 80 ? turnText.slice(0, 80) + "..." : turnText;
        warnOrInfo(logger,
          "openviking: capture-check " +
            "shouldCapture=" + String(decision.shouldCapture) + " " +
            "reason=" + decision.reason + " newMsgCount=" + newCount + " text=\"" + preview + "\"",
        );

        if (!decision.shouldCapture) {
          warnOrInfo(logger, "openviking: auto-capture skipped (capture decision rejected)");
          return;
        }

        const client = await getClient();
        const OVSessionId = sessionKey ?? afterTurnParams.sessionId;
        await client.addSessionMessage(OVSessionId, "user", decision.normalizedText, agentId);
        const commitResult = await client.commitSession(OVSessionId, { wait: true, agentId });
        warnOrInfo(logger,
          "openviking: committed " + newCount + " messages in session=" + OVSessionId + ", " +
            "archived=" + (commitResult.archived ?? false) + ", memories=" + (commitResult.memories_extracted ?? 0) + ", " +
            "task_id=" + (commitResult.task_id ?? "none"),
        );
      } catch (err) {
        warnOrInfo(logger, "openviking: auto-capture failed: " + String(err));
      } finally {
        if (sessionId) commitLocks.delete(sessionId);
      }
    },

    async compact(compactParams): Promise<CompactResult> {
      const delegated = await tryLegacyCompact(compactParams);
      if (delegated) {
        return delegated;
      }

      warnOrInfo(
        logger,
        "openviking: legacy compaction delegation unavailable; skipping compact",
      );

      return {
        ok: true,
        compacted: false,
        reason: "legacy_compact_unavailable",
      };
    },

    resolveOVSession: async (sessionKey: string): Promise<string> => {
      return sessionKey;
    },
    commitOVSession: async (sessionKey: string): Promise<void> => {
      const client = await getClient();
      const agentId = resolveAgentId(sessionKey);
      await client.addSessionMessage(sessionKey, "user", "[session reset commit]", agentId);
      await client.commitSession(sessionKey, { wait: true, agentId });
      warnOrInfo(logger, "openviking: committed OV session on reset for sessionKey=" + sessionKey);
    },
  };

  return contextEnginePlugin;
}

export type ContextEngineWithSessionMapping = MemoryOpenVikingContextEngine;

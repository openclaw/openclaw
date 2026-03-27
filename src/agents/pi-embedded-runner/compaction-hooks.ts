import path from "node:path";

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { createInternalHookEvent, triggerInternalHook } from "../../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createEpisodeEncoder } from "../../memory/episodic/encoder.js";
import { EpisodicStore } from "../../memory/episodic/store.js";
import { buildSessionEntry } from "../../plugins/memory-host/session-files.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { emitSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { resolveAgentDir, resolveSessionAgentId } from "../agent-scope.js";
import { resolveMemorySearchConfig } from "../memory-search.js";
import { log } from "./logger.js";

const memLog = createSubsystemLogger("memory");

function resolvePostCompactionIndexSyncMode(config?: OpenClawConfig): "off" | "async" | "await" {
  const mode = config?.agents?.defaults?.compaction?.postIndexSync;
  if (mode === "off" || mode === "async" || mode === "await") {
    return mode;
  }
  return "async";
}

async function runPostCompactionSessionMemorySync(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
}): Promise<void> {
  if (!params.config) {
    return;
  }
  try {
    const sessionFile = params.sessionFile.trim();
    if (!sessionFile) {
      return;
    }
    const agentId = resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    const resolvedMemory = resolveMemorySearchConfig(params.config, agentId);
    if (!resolvedMemory || !resolvedMemory.sources.includes("sessions")) {
      return;
    }
    if (!resolvedMemory.sync.sessions.postCompactionForce) {
      return;
    }
    const { manager } = await getActiveMemorySearchManager({
      cfg: params.config,
      agentId,
    });
    if (!manager?.sync) {
      return;
    }
    await manager.sync({
      reason: "post-compaction",
      sessionFiles: [sessionFile],
    });
  } catch (err) {
    log.warn(`memory sync skipped (post-compaction): ${String(err)}`);
  }
}

function syncPostCompactionSessionMemory(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
  mode: "off" | "async" | "await";
}): Promise<void> {
  if (params.mode === "off" || !params.config) {
    return Promise.resolve();
  }

  const syncTask = runPostCompactionSessionMemorySync({
    config: params.config,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
  });
  if (params.mode === "await") {
    return syncTask;
  }
  void syncTask;
  return Promise.resolve();
}

async function runPostCompactionEpisodicEncoding(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionFile: string;
}): Promise<void> {
  const memSearch = resolveMemorySearchConfig(params.config, params.agentId);
  const episodicCfg = memSearch?.episodic;
  if (!episodicCfg?.enabled) {
    return;
  }

  const entry = await buildSessionEntry(params.sessionFile);
  if (!entry || !entry.content.trim()) {
    return;
  }

  // Check minimum turns (each "User:" or "Assistant:" prefix is a turn)
  const minTurns = episodicCfg.minConversationTurns;
  const turnCount = (entry.content.match(/^(User|Assistant):/gm) ?? []).length;
  if (turnCount < minTurns) {
    return;
  }

  const encoder = createEpisodeEncoder(params.config, params.agentId);
  const episodes = await encoder.encode(entry.content, params.agentId);
  if (episodes.length === 0) {
    return;
  }

  const agentBaseDir = resolveAgentDir(params.config, params.agentId);
  const dbPath = path.join(agentBaseDir, "episodic", "episodes.db");
  const store = new EpisodicStore(dbPath);
  try {
    const sessionKey = path.basename(params.sessionFile, ".jsonl");
    for (const ep of episodes) {
      // Generate embedding for the episode so semantic search works immediately
      let embedding: Float32Array | undefined;
      try {
        embedding = await encoder.generateEmbedding(
          ep.summary + (ep.details ? ` ${ep.details}` : ""),
        );
      } catch {
        // Embedding generation is best-effort; store episode without it
      }
      store.create({
        agent_id: params.agentId,
        session_key: sessionKey,
        created_at: new Date().toISOString(),
        summary: ep.summary,
        details: ep.details,
        participants: ep.participants,
        importance: ep.importance,
        emotional_valence: ep.emotional_valence,
        emotional_arousal: ep.emotional_arousal,
        topic_tags: ep.topic_tags,
        embedding,
      });
    }
    memLog.info(
      `episodic: stored ${episodes.length} episode(s) from ${path.basename(params.sessionFile)}`,
    );
  } finally {
    store.close();
  }
}

export async function runPostCompactionSideEffects(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionFile: string;
}): Promise<void> {
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile) {
    return;
  }
  emitSessionTranscriptUpdate(sessionFile);
  await syncPostCompactionSessionMemory({
    config: params.config,
    sessionKey: params.sessionKey,
    sessionFile,
    mode: resolvePostCompactionIndexSyncMode(params.config),
  });
  // Episodic memory encoding — runs after session memory sync, never breaks main flow
  if (params.config) {
    const agentId = resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    try {
      await runPostCompactionEpisodicEncoding({
        config: params.config,
        agentId,
        sessionFile,
      });
    } catch (err) {
      memLog.warn(`episodic encoding skipped (post-compaction): ${String(err)}`);
    }
  }
}

export type CompactionHookRunner = {
  hasHooks?: (hookName?: string) => boolean;
  runBeforeCompaction?: (
    metrics: { messageCount: number; tokenCount?: number; sessionFile?: string },
    context: {
      sessionId: string;
      agentId: string;
      sessionKey: string;
      workspaceDir: string;
      messageProvider?: string;
    },
  ) => Promise<void> | void;
  runAfterCompaction?: (
    metrics: {
      messageCount: number;
      tokenCount?: number;
      compactedCount: number;
      sessionFile: string;
    },
    context: {
      sessionId: string;
      agentId: string;
      sessionKey: string;
      workspaceDir: string;
      messageProvider?: string;
    },
  ) => Promise<void> | void;
};

export function asCompactionHookRunner(
  hookRunner: ReturnType<typeof getGlobalHookRunner> | null | undefined,
): CompactionHookRunner | null {
  if (!hookRunner) {
    return null;
  }
  return {
    hasHooks: (hookName?: string) => hookRunner.hasHooks?.(hookName as never) ?? false,
    runBeforeCompaction: hookRunner.runBeforeCompaction?.bind(hookRunner),
    runAfterCompaction: hookRunner.runAfterCompaction?.bind(hookRunner),
  };
}

function estimateTokenCountSafe(
  messages: AgentMessage[],
  estimateTokensFn: (message: AgentMessage) => number,
): number | undefined {
  try {
    let total = 0;
    for (const message of messages) {
      total += estimateTokensFn(message);
    }
    return total;
  } catch {
    return undefined;
  }
}

export function buildBeforeCompactionHookMetrics(params: {
  originalMessages: AgentMessage[];
  currentMessages: AgentMessage[];
  observedTokenCount?: number;
  estimateTokensFn: (message: AgentMessage) => number;
}) {
  return {
    messageCountOriginal: params.originalMessages.length,
    tokenCountOriginal: estimateTokenCountSafe(params.originalMessages, params.estimateTokensFn),
    messageCountBefore: params.currentMessages.length,
    tokenCountBefore:
      params.observedTokenCount ??
      estimateTokenCountSafe(params.currentMessages, params.estimateTokensFn),
  };
}

export async function runBeforeCompactionHooks(params: {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionKey?: string;
  sessionAgentId: string;
  workspaceDir: string;
  messageProvider?: string;
  metrics: ReturnType<typeof buildBeforeCompactionHookMetrics>;
}) {
  const missingSessionKey = !params.sessionKey || !params.sessionKey.trim();
  const hookSessionKey = params.sessionKey?.trim() || params.sessionId;
  try {
    const hookEvent = createInternalHookEvent("session", "compact:before", hookSessionKey, {
      sessionId: params.sessionId,
      missingSessionKey,
      messageCount: params.metrics.messageCountBefore,
      tokenCount: params.metrics.tokenCountBefore,
      messageCountOriginal: params.metrics.messageCountOriginal,
      tokenCountOriginal: params.metrics.tokenCountOriginal,
    });
    await triggerInternalHook(hookEvent);
  } catch (err) {
    log.warn("session:compact:before hook failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
  }
  if (params.hookRunner?.hasHooks?.("before_compaction")) {
    try {
      await params.hookRunner.runBeforeCompaction?.(
        {
          messageCount: params.metrics.messageCountBefore,
          tokenCount: params.metrics.tokenCountBefore,
        },
        {
          sessionId: params.sessionId,
          agentId: params.sessionAgentId,
          sessionKey: hookSessionKey,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageProvider,
        },
      );
    } catch (err) {
      log.warn("before_compaction hook failed", {
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
  return {
    hookSessionKey,
    missingSessionKey,
  };
}

export function estimateTokensAfterCompaction(params: {
  messagesAfter: AgentMessage[];
  observedTokenCount?: number;
  fullSessionTokensBefore: number;
  estimateTokensFn: (message: AgentMessage) => number;
}) {
  const tokensAfter = estimateTokenCountSafe(params.messagesAfter, params.estimateTokensFn);
  if (tokensAfter === undefined) {
    return undefined;
  }
  const sanityCheckBaseline = params.observedTokenCount ?? params.fullSessionTokensBefore;
  if (
    sanityCheckBaseline > 0 &&
    tokensAfter >
      (params.observedTokenCount !== undefined ? sanityCheckBaseline : sanityCheckBaseline * 1.1)
  ) {
    return undefined;
  }
  return tokensAfter;
}

export async function runAfterCompactionHooks(params: {
  hookRunner?: CompactionHookRunner | null;
  sessionId: string;
  sessionAgentId: string;
  hookSessionKey: string;
  missingSessionKey: boolean;
  workspaceDir: string;
  messageProvider?: string;
  messageCountAfter: number;
  tokensAfter?: number;
  compactedCount: number;
  sessionFile: string;
  summaryLength?: number;
  tokensBefore?: number;
  firstKeptEntryId?: string;
}) {
  try {
    const hookEvent = createInternalHookEvent("session", "compact:after", params.hookSessionKey, {
      sessionId: params.sessionId,
      missingSessionKey: params.missingSessionKey,
      messageCount: params.messageCountAfter,
      tokenCount: params.tokensAfter,
      compactedCount: params.compactedCount,
      summaryLength: params.summaryLength,
      tokensBefore: params.tokensBefore,
      tokensAfter: params.tokensAfter,
      firstKeptEntryId: params.firstKeptEntryId,
    });
    await triggerInternalHook(hookEvent);
  } catch (err) {
    log.warn("session:compact:after hook failed", {
      errorMessage: err instanceof Error ? err.message : String(err),
      errorStack: err instanceof Error ? err.stack : undefined,
    });
  }
  if (params.hookRunner?.hasHooks?.("after_compaction")) {
    try {
      await params.hookRunner.runAfterCompaction?.(
        {
          messageCount: params.messageCountAfter,
          tokenCount: params.tokensAfter,
          compactedCount: params.compactedCount,
          sessionFile: params.sessionFile,
        },
        {
          sessionId: params.sessionId,
          agentId: params.sessionAgentId,
          sessionKey: params.hookSessionKey,
          workspaceDir: params.workspaceDir,
          messageProvider: params.messageProvider,
        },
      );
    } catch (err) {
      log.warn("after_compaction hook failed", {
        errorMessage: err instanceof Error ? err.message : String(err),
        errorStack: err instanceof Error ? err.stack : undefined,
      });
    }
  }
}

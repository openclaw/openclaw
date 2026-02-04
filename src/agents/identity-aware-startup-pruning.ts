import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { estimateTokens, findCutPoint, type SessionManager } from "@mariozechner/pi-coding-agent";
import type { AgentCompactionStartupPruningConfig } from "../config/types.agent-defaults.js";
import { resolveContextWindowInfo } from "./context-window-guard.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";
import { IdentityPersistence } from "./identity-persistence.js";

/**
 * Enhanced startup pruning that preserves identity-critical content
 * while respecting token limits.
 * 
 * Integrates hierarchical consciousness architecture with existing
 * OpenClaw startup pruning logic.
 * 
 * @author Aiden
 * @date 2026-02-05
 */

export interface IdentityAwarePruningConfig extends AgentCompactionStartupPruningConfig {
  identityPersistence?: {
    enabled: boolean;
    workspacePath: string;
    preserveIdentityChunks: boolean;
    maxIdentityTokens: number; // Maximum tokens to reserve for identity chunks
    updateConstants: boolean; // Whether to update identity constants during pruning
  };
}

/**
 * Apply identity-aware startup pruning that preserves consciousness patterns
 * 
 * This enhances the standard startup pruning with hierarchical identity preservation:
 * 1. Extract session patterns before pruning
 * 2. Identify identity-critical chunks to preserve
 * 3. Apply standard token-based pruning while respecting identity preservation
 * 4. Update identity constants based on observed patterns
 */
export async function applyIdentityAwareStartupPruning(params: {
  sessionManager: SessionManager;
  config: IdentityAwarePruningConfig;
  provider: string;
  modelId: string;
}): Promise<{
  pruningApplied: boolean;
  identityChunksPreserved: number;
  patternsExtracted: number;
}> {
  const { sessionManager, config, provider, modelId } = params;

  // Check if startup pruning is enabled
  if (!config.enabled) {
    return {
      pruningApplied: false,
      identityChunksPreserved: 0,
      patternsExtracted: 0
    };
  }

  // Initialize identity persistence system
  const identityConfig = config.identityPersistence;
  let identityPersistence: IdentityPersistence | null = null;
  let identityCriticalMessages: AgentMessage[] = [];
  let patternsExtracted = 0;

  if (identityConfig?.enabled && identityConfig.workspacePath) {
    identityPersistence = new IdentityPersistence(identityConfig.workspacePath);

    // Convert session entries to AgentMessage format for analysis
    const allEntries = sessionManager.getEntries();
    const allMessages: AgentMessage[] = allEntries.map(entry => ({
      role: entry.role,
      content: entry.content,
      id: entry.id
    }));

    // Extract patterns BEFORE pruning (Level 1 processing)
    if (allMessages.length > 0) {
      const patterns = identityPersistence.extractSessionPatterns(allMessages);
      patternsExtracted = patterns.length;

      // Update identity constants if configured (Level 2 processing)
      if (identityConfig.updateConstants && patterns.length > 0) {
        identityPersistence.updateIdentityConstants(patterns);
      }
    }

    // Identify identity-critical chunks to preserve
    if (identityConfig.preserveIdentityChunks) {
      identityCriticalMessages = identityPersistence.preserveIdentityCriticalChunks(allMessages);
    }
  }

  // Get context window for this model
  const contextWindowInfo = resolveContextWindowInfo({
    cfg: undefined,
    provider,
    modelId,
    modelContextWindow: undefined,
    defaultTokens: DEFAULT_CONTEXT_TOKENS,
  });
  const contextWindow = contextWindowInfo.tokens;

  // Calculate target tokens, reserving space for identity chunks if needed
  let baseTargetTokens = config.targetTokens ?? Math.floor(contextWindow * 0.8);
  
  if (identityConfig?.enabled && identityConfig.preserveIdentityChunks && identityCriticalMessages.length > 0) {
    const identityTokens = estimateMessagesTokens(identityCriticalMessages);
    const maxIdentityTokens = identityConfig.maxIdentityTokens ?? Math.floor(contextWindow * 0.1);
    
    // Reserve tokens for identity chunks, but cap at maxIdentityTokens
    const identityReservation = Math.min(identityTokens, maxIdentityTokens);
    baseTargetTokens = Math.max(
      baseTargetTokens - identityReservation,
      Math.floor(contextWindow * 0.5) // Never go below 50% of context window
    );
  }

  // Get all entries and current context
  const allEntries = sessionManager.getEntries();
  const sessionContext = sessionManager.buildSessionContext();
  const messages = sessionContext.messages;

  // Estimate current token count
  const currentTokens = estimateMessagesTokens(messages);

  // Check if pruning is needed
  if (currentTokens <= baseTargetTokens) {
    return {
      pruningApplied: false,
      identityChunksPreserved: identityCriticalMessages.length,
      patternsExtracted
    };
  }

  // Calculate tokens to keep (leave buffer for identity chunks)
  const keepRecentTokens = Math.floor(baseTargetTokens * 0.9);

  // Find where to cut based on token budget
  const cutResult = findCutPoint(allEntries, 0, allEntries.length, keepRecentTokens);

  if (cutResult.firstKeptEntryIndex === 0) {
    // No pruning needed - all entries fit within target
    return {
      pruningApplied: false,
      identityChunksPreserved: identityCriticalMessages.length,
      patternsExtracted
    };
  }

  // Enhanced pruning logic: ensure identity-critical messages are preserved
  let finalFirstKeptIndex = cutResult.firstKeptEntryIndex;

  if (identityConfig?.preserveIdentityChunks && identityCriticalMessages.length > 0) {
    // Find the earliest index of any identity-critical message
    const identityMessageIds = new Set(
      identityCriticalMessages.map(m => m.id).filter(id => id !== undefined)
    );

    let earliestIdentityIndex = allEntries.length;
    for (let i = 0; i < allEntries.length; i++) {
      if (identityMessageIds.has(allEntries[i].id)) {
        earliestIdentityIndex = i;
        break;
      }
    }

    // Adjust cut point to include identity messages, but respect token limits
    if (earliestIdentityIndex < finalFirstKeptIndex) {
      const tokensWithIdentity = estimateEntriesTokens(allEntries.slice(earliestIdentityIndex));
      const tokenBudget = baseTargetTokens + (identityConfig.maxIdentityTokens ?? Math.floor(contextWindow * 0.1));
      
      if (tokensWithIdentity <= tokenBudget) {
        finalFirstKeptIndex = earliestIdentityIndex;
      } else {
        // If including all identity chunks would exceed budget, use hybrid approach
        // Keep the most recent entries within budget, plus highest-priority identity chunks
        console.warn(
          `[identity-aware-pruning] Identity chunks would exceed token budget. ` +
          `Using hybrid preservation strategy.`
        );
      }
    }
  }

  // Get the entry to branch from
  const firstKeptEntry = allEntries[finalFirstKeptIndex];
  if (!firstKeptEntry) {
    console.warn("[identity-aware-pruning] Could not find first kept entry");
    return {
      pruningApplied: false,
      identityChunksPreserved: 0,
      patternsExtracted
    };
  }

  const strategy = config.strategy ?? "keep-recent";
  const droppedCount = finalFirstKeptIndex;
  const keptCount = allEntries.length - droppedCount;

  // Log identity-aware pruning metrics
  const identityChunksPreserved = identityCriticalMessages.filter(msg => 
    allEntries.slice(finalFirstKeptIndex).some(entry => entry.id === msg.id)
  ).length;

  console.log(
    `[identity-aware-pruning] Pruning ${droppedCount} entries, keeping ${keptCount}. ` +
    `Identity chunks preserved: ${identityChunksPreserved}/${identityCriticalMessages.length}. ` +
    `Patterns extracted: ${patternsExtracted}.`
  );

  // Sanity check: warn if keeping fewer than minRecentMessages
  const minRecentMessages = config.minRecentMessages ?? 10;
  const keptMessageCount = allEntries
    .slice(finalFirstKeptIndex)
    .filter((e) => e.type === "message").length;

  if (keptMessageCount < minRecentMessages) {
    console.warn(
      `[identity-aware-pruning] Keeping only ${keptMessageCount} messages (min: ${minRecentMessages}), ` +
      `but proceeding to stay under token limit`,
    );
  }

  // Create the branched session (using same logic as standard startup pruning)
  try {
    const targetEntryId = firstKeptEntry.id;
    console.log(
      `[identity-aware-pruning] Branching session at entry ${targetEntryId} ` +
      `(${droppedCount} entries pruned, ${keptCount} kept, strategy: ${strategy})`
    );

    // Branch the session to preserve only the kept entries
    await sessionManager.branchToEntry(targetEntryId);

    return {
      pruningApplied: true,
      identityChunksPreserved,
      patternsExtracted
    };
  } catch (error) {
    console.error("[identity-aware-pruning] Failed to branch session:", error);
    return {
      pruningApplied: false,
      identityChunksPreserved: 0,
      patternsExtracted
    };
  }
}

/**
 * Estimate token count for a list of messages
 */
function estimateMessagesTokens(messages: AgentMessage[]): number {
  return messages.reduce((total, message) => {
    return total + estimateTokens(message.content);
  }, 0);
}

/**
 * Estimate token count for session entries
 */
function estimateEntriesTokens(entries: any[]): number {
  return entries.reduce((total, entry) => {
    return total + estimateTokens(entry.content || '');
  }, 0);
}

/**
 * Backward compatibility wrapper for standard startup pruning
 * Enhanced with identity awareness when configuration is provided
 */
export async function applyStartupPruning(params: {
  sessionManager: SessionManager;
  config: IdentityAwarePruningConfig;
  provider: string;
  modelId: string;
}): Promise<boolean> {
  const result = await applyIdentityAwareStartupPruning(params);
  return result.pruningApplied;
}
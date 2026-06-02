import { mergeOrphanedTrailingUserPrompt } from "./attempt.prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type OrphanedTrailingUserPromptMergeParams = {
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
  /** The current session leaf that would otherwise create consecutive user turns. */
  leafMessage: { content?: unknown };
};

/** Result of folding an active-turn user leaf into the next inbound prompt. */
export type OrphanedTrailingUserPromptMergeResult = {
  prompt: string;
  merged: boolean;
  /**
   * When false, the active session leaf is preserved. Use this only when the
   * caller intentionally accepts that the next appended prompt may follow an
   * existing user leaf; most providers reject consecutive user turns.
   */
  removeLeaf: boolean;
};

export type MessageMergeStrategyId = "orphan-trailing-user-prompt";

/**
 * Runtime hook for resolving provider-hostile transcript tails before retrying.
 * The strategy object exists so tests can exercise runner behavior without
 * depending on the default merge text.
 */
export type MessageMergeStrategy = {
  id: MessageMergeStrategyId;
  mergeOrphanedTrailingUserPrompt: (
    params: OrphanedTrailingUserPromptMergeParams,
  ) => OrphanedTrailingUserPromptMergeResult;
};

export const DEFAULT_MESSAGE_MERGE_STRATEGY_ID: MessageMergeStrategyId =
  "orphan-trailing-user-prompt";

const defaultMessageMergeStrategy: MessageMergeStrategy = {
  id: DEFAULT_MESSAGE_MERGE_STRATEGY_ID,
  mergeOrphanedTrailingUserPrompt,
};

let activeMessageMergeStrategy = defaultMessageMergeStrategy;

/** Returns the active merge strategy used before retrying a transcript with a hostile tail. */
export function resolveMessageMergeStrategy(): MessageMergeStrategy {
  return activeMessageMergeStrategy;
}

function registerMessageMergeStrategy(strategy: MessageMergeStrategy): () => void {
  const previous = activeMessageMergeStrategy;
  activeMessageMergeStrategy = strategy;
  return () => {
    activeMessageMergeStrategy = previous;
  };
}

/**
 * Installs a temporary message merge strategy and returns a restore callback.
 * Keep this test-only so production uses the canonical orphan-user merge path.
 */
export function registerMessageMergeStrategyForTest(strategy: MessageMergeStrategy): () => void {
  return registerMessageMergeStrategy(strategy);
}

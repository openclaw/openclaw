import { mergeOrphanedTrailingUserPrompt } from "./attempt.prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/**
 * Inputs for repairing a queued prompt when the active transcript already ends
 * with a user message.
 */
export type OrphanedTrailingUserPromptMergeParams = {
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
  leafMessage: { content?: unknown };
};

/**
 * Result of a prompt repair pass, including whether the transcript leaf should
 * be removed after its text was folded into the next prompt.
 */
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

/**
 * Stable strategy id for the current embedded-run prompt merge contract.
 */
export type MessageMergeStrategyId = "orphan-trailing-user-prompt";

/**
 * Strategy object used by the runtime and contract tests to keep transcript
 * repair behavior replaceable without coupling callers to the helper module.
 */
export type MessageMergeStrategy = {
  id: MessageMergeStrategyId;
  mergeOrphanedTrailingUserPrompt: (
    params: OrphanedTrailingUserPromptMergeParams,
  ) => OrphanedTrailingUserPromptMergeResult;
};

/**
 * Default strategy id used when no runtime adapter overrides prompt merging.
 */
export const DEFAULT_MESSAGE_MERGE_STRATEGY_ID: MessageMergeStrategyId =
  "orphan-trailing-user-prompt";

const defaultMessageMergeStrategy: MessageMergeStrategy = {
  id: DEFAULT_MESSAGE_MERGE_STRATEGY_ID,
  mergeOrphanedTrailingUserPrompt,
};

let activeMessageMergeStrategy = defaultMessageMergeStrategy;

/**
 * Resolve the active merge strategy for an embedded attempt.
 */
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
 * Install a temporary merge strategy for contract tests and restore the
 * previous strategy with the returned cleanup function.
 */
export function registerMessageMergeStrategyForTest(strategy: MessageMergeStrategy): () => void {
  return registerMessageMergeStrategy(strategy);
}

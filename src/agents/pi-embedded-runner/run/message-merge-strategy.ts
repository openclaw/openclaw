import { mergeOrphanedTrailingUserPrompt } from "./attempt.prompt-helpers.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export type OrphanedTrailingUserPromptMergeParams = {
  prompt: string;
  trigger: EmbeddedRunAttemptParams["trigger"];
  leafMessage: { content?: unknown };
};

export type OrphanedTrailingUserPromptMergeResult = {
  prompt: string;
  merged: boolean;
  removeLeaf: boolean;
};

export type MessageMergeStrategyId = "orphan-trailing-user-prompt";

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

export function registerMessageMergeStrategyForTest(strategy: MessageMergeStrategy): () => void {
  return registerMessageMergeStrategy(strategy);
}

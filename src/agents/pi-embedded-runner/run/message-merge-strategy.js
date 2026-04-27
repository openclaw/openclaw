import { mergeOrphanedTrailingUserPrompt } from "./attempt.prompt-helpers.js";
export const DEFAULT_MESSAGE_MERGE_STRATEGY_ID = "orphan-trailing-user-prompt";
const defaultMessageMergeStrategy = {
    id: DEFAULT_MESSAGE_MERGE_STRATEGY_ID,
    mergeOrphanedTrailingUserPrompt,
};
let activeMessageMergeStrategy = defaultMessageMergeStrategy;
export function resolveMessageMergeStrategy() {
    return activeMessageMergeStrategy;
}
function registerMessageMergeStrategy(strategy) {
    const previous = activeMessageMergeStrategy;
    activeMessageMergeStrategy = strategy;
    return () => {
        activeMessageMergeStrategy = previous;
    };
}
export function registerMessageMergeStrategyForTest(strategy) {
    return registerMessageMergeStrategy(strategy);
}

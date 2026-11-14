import { buildBootstrapBudgetState } from "../../bootstrap-budget.js";
import type { prepareEmbeddedAttemptSystemPrompt } from "./attempt-system-prompt-prepare.js";

export function createEmptyPromptBootstrap(): Parameters<
  typeof prepareEmbeddedAttemptSystemPrompt
>[0]["bootstrap"] {
  return {
    ...buildBootstrapBudgetState({ files: [] }),
    bootstrapMode: "full",
    contextFiles: [],
    bootstrapInjectionStats: [],
    shouldRecordCompletedBootstrapTurn: false,
    workspaceNotes: [],
  };
}

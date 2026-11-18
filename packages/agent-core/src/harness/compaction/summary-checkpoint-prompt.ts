import type { Model } from "@openclaw/llm-core";
import type { CompactionSummaryPrompt } from "./compaction.js";

/** Shared checkpoint structure; each summarizer supplies its exact section instructions. */
export function buildSummaryCheckpointPrompt(sections: {
  introduction: string;
  goal: string;
  constraints: string;
  done?: string;
  inProgress: string;
  blocked: string;
  decisions: string;
  nextSteps: string;
  criticalContext?: string;
}): string {
  return [
    sections.introduction,
    "Use this EXACT format:",
    `## Goal\n${sections.goal}`,
    `## Constraints & Preferences\n${sections.constraints}`,
    `## Progress\n### Done\n${sections.done ?? "- [x] [Completed tasks/changes]"}`,
    `### In Progress\n${sections.inProgress}`,
    `### Blocked\n${sections.blocked}`,
    `## Key Decisions\n${sections.decisions}`,
    `## Next Steps\n${sections.nextSteps}`,
    ...(sections.criticalContext === undefined
      ? []
      : [`## Critical Context\n${sections.criticalContext}`]),
    "Keep each section concise. Preserve exact file paths, function names, and error messages.",
  ].join("\n\n");
}

const SUMMARIZATION_PROMPT = buildSummaryCheckpointPrompt({
  introduction:
    "The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.",
  goal: "[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]",
  constraints:
    '- [Any constraints, preferences, or requirements mentioned by user]\n- [Or "(none)" if none were mentioned]',
  inProgress: "- [ ] [Current work]",
  blocked: "- [Issues preventing progress, if any]",
  decisions: "- **[Decision]**: [Brief rationale]",
  nextSteps: "1. [Ordered list of what should happen next]",
  criticalContext:
    '- [Any data, examples, or references needed to continue]\n- [Or "(none)" if not applicable]',
});

const UPDATE_SUMMARIZATION_PROMPT = buildSummaryCheckpointPrompt({
  introduction: `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed. Record checks that ran and their results as completed, even when they failed; keep unresolved blockers separate.
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it`,
  goal: "[Preserve existing goals, add new ones if the task expanded]",
  constraints: "- [Preserve existing, add new ones discovered]",
  done: "- [x] [Include previously done items AND newly completed items]",
  inProgress: "- [ ] [Current work - update based on progress]",
  blocked: "- [Current blockers - remove if resolved]",
  decisions: "- **[Decision]**: [Brief rationale] (preserve all previous, add new)",
  nextSteps: "1. [Update based on current state]",
  criticalContext: "- [Preserve important context, add new if needed]",
});

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

/** @internal Array and worker-source consumers share exact prompt and output policy. */
export function prepareCompactionSummaryRequest(params: {
  model: Model;
  reserveTokens: number;
  previousSummary?: string;
  summaryPrompt?: CompactionSummaryPrompt;
}) {
  const { model, reserveTokens, previousSummary, summaryPrompt } = params;
  const maxTokens = Math.min(
    Math.floor((summaryPrompt?.kind === "turn-prefix" ? 0.5 : 0.8) * reserveTokens),
    model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
  );
  const selectedPrompt =
    summaryPrompt?.kind === "turn-prefix"
      ? TURN_PREFIX_SUMMARIZATION_PROMPT
      : summaryPrompt?.instructions;
  const promptWithoutProvenance = summaryPrompt
    ? [
        previousSummary &&
          "Update the previous summary with the new conversation. Preserve relevant facts, decisions, and unresolved asks; remove stale or duplicate detail. Use the format below.",
        selectedPrompt,
      ]
        .filter(Boolean)
        .join("\n\n")
    : previousSummary
      ? UPDATE_SUMMARIZATION_PROMPT
      : SUMMARIZATION_PROMPT;
  return {
    prompt: promptWithoutProvenance,
    maxTokens,
    errorLabel:
      summaryPrompt?.kind === "turn-prefix" ? "Turn prefix summarization" : "Summarization",
  };
}

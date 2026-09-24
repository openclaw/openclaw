import { vi } from "vitest";
import { createModelExecAutoReviewer } from "./exec-auto-reviewer.js";
import type {
  acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel,
} from "./simple-completion-runtime.js";
import { makeAssistantMessageFixture } from "./test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

export const input = {
  // Baseline approval request is read-only; individual cases override command
  // text or analysis fields to exercise escalation behavior.
  command: "git status",
  argv: ["git", "status"],
  resolvedPath: "/usr/bin/git",
  cwd: "/repo",
  envKeys: [],
  host: "gateway" as const,
  reason: "approval-required" as const,
  analysis: {
    parsed: true,
    allowlistMatched: false,
    inlineEval: false,
  },
};

export function createReviewerHarness(
  decision: "allow" | "ask" = "allow",
  modelOverrides?: { maxTokens?: number },
) {
  const prepare = vi.fn<typeof acquireSimpleCompletionModelForAgent>(async () => ({
    selection: { provider: "openrouter", modelId: "reviewer", agentDir: "/agent" },
    model: makeProviderModelFixture({
      provider: "openrouter",
      id: "reviewer",
      api: "openai",
      baseUrl: "https://reviewer.example.com",
      ...modelOverrides,
    }),
    auth: { apiKey: "redacted", mode: "api-key" as const, source: "test fixture" },
    [Symbol.asyncDispose]: async () => {},
  }));
  const complete = vi.fn<typeof completeWithPreparedSimpleCompletionModel>(async () =>
    makeAssistantMessageFixture({
      stopReason: "stop",
      errorMessage: undefined,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            decision,
            risk: decision === "allow" ? "low" : "medium",
            rationale: "reviewer fixture",
          }),
        },
      ],
    }),
  );
  const reviewer = createModelExecAutoReviewer({
    cfg: {},
    deps: {
      acquireSimpleCompletionModelForAgent: prepare,
      completeWithPreparedSimpleCompletionModel: complete,
    },
  });
  return { reviewer, prepare, complete };
}

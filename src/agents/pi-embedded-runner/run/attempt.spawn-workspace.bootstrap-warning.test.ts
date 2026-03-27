import { describe, expect, it } from "vitest";
import {
  analyzeBootstrapBudget,
  buildBootstrapInjectionStats,
  buildBootstrapPromptWarning,
  prependBootstrapPromptWarning,
} from "../../bootstrap-budget.js";
import { composeSystemPromptWithHookContext } from "./attempt.thread-helpers.js";

describe("runEmbeddedAttempt bootstrap warning prompt assembly", () => {
  it("keeps bootstrap warnings in the sent prompt after hook prepend context", () => {
    const analysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles: [
          {
            name: "AGENTS.md",
            path: "/tmp/openclaw-warning-workspace/AGENTS.md",
            content: "A".repeat(200),
            missing: false,
          },
        ],
        injectedFiles: [{ path: "AGENTS.md", content: "A".repeat(20) }],
      }),
      bootstrapMaxChars: 50,
      bootstrapTotalMaxChars: 50,
    });
    const warning = buildBootstrapPromptWarning({
      analysis,
      mode: "once",
    });
    const promptWithWarning = prependBootstrapPromptWarning("hello", warning.lines);
    const systemPrompt = composeSystemPromptWithHookContext({
      baseSystemPrompt: promptWithWarning,
      prependSystemContext: "hook context",
    });

    expect(systemPrompt).toContain("hook context");
    expect(systemPrompt).toContain("[Bootstrap truncation warning]");
    expect(systemPrompt).toContain("- AGENTS.md: 200 raw -> 20 injected");
    expect(systemPrompt).toContain("hello");
  });
});

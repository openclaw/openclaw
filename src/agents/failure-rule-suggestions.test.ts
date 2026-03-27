import { describe, expect, it } from "vitest";
import { buildFailureRuleSuggestions } from "./failure-rule-suggestions.js";

describe("buildFailureRuleSuggestions", () => {
  it("suggests verification, retry, and context-budget rules from structured failure signals", () => {
    const suggestions = buildFailureRuleSuggestions({
      report: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        promptBudget: {
          totalTrackedChars: 20_030,
          workspaceInjectedChars: 10_000,
          skillsPromptChars: 10,
          toolListChars: 10,
          otherSystemPromptChars: 0,
          toolSchemaChars: 10_010,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 10,
          entries: [],
        },
        tools: {
          listChars: 10,
          schemaChars: 10_010,
          entries: [],
        },
      },
      failureReport: {
        status: "failed",
        generatedAt: Date.now(),
        category: "verification",
        source: "verify-runner",
        code: "verify_failed",
        summary: "1/2 verification checks failed",
        verifyChecksRun: 2,
        verifyChecksFailed: 1,
      },
      retryReport: {
        status: "used",
        generatedAt: Date.now(),
        maxAttempts: 8,
        attemptsUsed: 3,
        retriesUsed: 2,
        remainingRetries: 5,
        entries: [],
      },
      verifyReport: {
        status: "failed",
        strategy: "command-tool",
        generatedAt: Date.now(),
        checksRun: 2,
        checksPassed: 1,
        checksFailed: 1,
        entries: [],
      },
    });

    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((entry) => entry.key)).toEqual([
      "verify-before-final",
      "stop-repeat-retries",
      "trim-tool-surface",
    ]);
  });

  it("suggests tool preflight rules for tool failures", () => {
    const suggestions = buildFailureRuleSuggestions({
      report: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 500,
          projectContextChars: 250,
          nonProjectContextChars: 250,
        },
        promptBudget: {
          totalTrackedChars: 700,
          workspaceInjectedChars: 100,
          skillsPromptChars: 100,
          toolListChars: 100,
          otherSystemPromptChars: 200,
          toolSchemaChars: 200,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 100,
          entries: [],
        },
        tools: {
          listChars: 100,
          schemaChars: 200,
          entries: [],
        },
      },
      failureReport: {
        status: "failed",
        generatedAt: Date.now(),
        category: "tool",
        source: "tool-result",
        code: "tool_error",
        summary: "browser open page failed",
        toolName: "browser",
      },
    });

    expect(suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "tool-preflight",
          title: "Add a tool preflight rule",
        }),
      ]),
    );
  });

  it("returns no suggestions when there is no structured failure or budget pressure", () => {
    const suggestions = buildFailureRuleSuggestions({
      report: {
        source: "run",
        generatedAt: Date.now(),
        systemPrompt: {
          chars: 300,
          projectContextChars: 150,
          nonProjectContextChars: 150,
        },
        promptBudget: {
          totalTrackedChars: 600,
          workspaceInjectedChars: 150,
          skillsPromptChars: 150,
          toolListChars: 150,
          otherSystemPromptChars: 100,
          toolSchemaChars: 50,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 150,
          entries: [],
        },
        tools: {
          listChars: 150,
          schemaChars: 50,
          entries: [],
        },
      },
    });

    expect(suggestions).toEqual([]);
  });
});

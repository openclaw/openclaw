import { describe, expect, it } from "vitest";
import { buildCronHealthCheckSuggestion } from "./cron-health-checks.js";

describe("buildCronHealthCheckSuggestion", () => {
  it("suggests a daily isolated cron check when verification failed", () => {
    const suggestion = buildCronHealthCheckSuggestion({
      report: {
        source: "run",
        generatedAt: Date.now(),
        workspacePolicyDiscovery: {
          totalDiscovered: 3,
          injectedCount: 2,
          candidateCount: 1,
          mergeOrder: ["AGENTS.md", "OPENCLAW.md"],
          conflictCount: 0,
          entries: [],
        },
        policySlicing: {
          totalSlicedChars: 543,
          slicedFileCount: 1,
          entries: [],
        },
        promptBudget: {
          totalTrackedChars: 20_500,
          workspaceInjectedChars: 6_000,
          skillsPromptChars: 1_000,
          toolListChars: 500,
          otherSystemPromptChars: 1_000,
          toolSchemaChars: 12_000,
        },
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 1_000,
          entries: [],
        },
        tools: {
          listChars: 500,
          schemaChars: 12_000,
          entries: [],
        },
      },
      failureReport: {
        status: "failed",
        generatedAt: Date.now(),
        category: "verification",
        source: "verify-runner",
        code: "verify_failed",
        summary: "1/1 verification checks failed",
        verifyChecksRun: 1,
        verifyChecksFailed: 1,
      },
      verifyReport: {
        status: "failed",
        strategy: "command-tool",
        generatedAt: Date.now(),
        checksRun: 1,
        checksPassed: 0,
        checksFailed: 1,
        entries: [],
      },
    });

    expect(suggestion.cadence).toBe("daily");
    expect(suggestion.schedule.expr).toBe("0 9 * * *");
    expect(suggestion.sessionTarget).toBe("isolated");
    expect(suggestion.lightContext).toBe(true);
    expect(suggestion.focus).toEqual(
      expect.arrayContaining([
        "verification failures",
        "candidate-only policy files",
        "sliced policy files",
        "tool schemas prompt cost",
      ]),
    );
  });

  it("suggests a weekly check when the latest run is healthy", () => {
    const suggestion = buildCronHealthCheckSuggestion({
      report: {
        source: "run",
        generatedAt: Date.now(),
        promptBudget: {
          totalTrackedChars: 4_000,
          workspaceInjectedChars: 1_000,
          skillsPromptChars: 500,
          toolListChars: 500,
          otherSystemPromptChars: 1_000,
          toolSchemaChars: 1_000,
        },
        systemPrompt: {
          chars: 1_000,
          projectContextChars: 500,
          nonProjectContextChars: 500,
        },
        injectedWorkspaceFiles: [],
        skills: {
          promptChars: 500,
          entries: [],
        },
        tools: {
          listChars: 500,
          schemaChars: 1_000,
          entries: [],
        },
      },
    });

    expect(suggestion.cadence).toBe("weekly");
    expect(suggestion.schedule.expr).toBe("0 9 * * 1");
    expect(suggestion.message).toContain("Review OpenClaw harness health");
  });
});

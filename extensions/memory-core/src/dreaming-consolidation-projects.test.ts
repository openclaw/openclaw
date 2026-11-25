import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { applyMemoryConsolidationPlan } from "./dreaming-consolidation.js";
import { consolidationCandidate } from "./dreaming-consolidation.test-support.js";
import type { PromotionCandidate } from "./short-term-promotion.js";
import { consolidateMemoryForTests as consolidateMemory } from "./test-helpers.js";

const logger = { info: vi.fn(), warn: vi.fn() };
const planDefaults = {
  nowMs: Date.parse("2026-07-02T10:00:00.000Z"),
  maxPriorEntryLossFraction: 0.25,
};
const consolidationDefaults = { ...planDefaults, logger };
const addDecisions = (prompt: ConsolidationPrompt) => ({
  operations: prompt.candidates.map((item) => ({
    candidateKey: item.key,
    action: "added" as const,
    priorEntries: [],
  })),
});

type ConsolidationPrompt = {
  candidates: Array<{ key: string; resultEntry: string; projectKey: string | null }>;
};

function projectCandidate(key: string, snippet: string, projectKey?: string): PromotionCandidate {
  return consolidationCandidate("agent", { key, snippet, ...(projectKey ? { projectKey } : {}) });
}

function createPromptResponder(
  respond: (prompt: ConsolidationPrompt) => {
    operations: Array<{
      candidateKey: string;
      action: "added" | "merged" | "superseded";
      priorEntries: string[];
    }>;
  },
) {
  return {
    complete: vi.fn(async (options: { message: string }) => ({
      text: JSON.stringify(respond(JSON.parse(options.message) as ConsolidationPrompt)),
    })),
  };
}

function consolidate(
  candidates: PromotionCandidate[],
  existingMemory: string,
  subagent = createPromptResponder(addDecisions),
  memoryFileMaxChars?: number,
) {
  return consolidateMemory({
    candidates,
    existingMemory,
    subagent,
    memoryFileMaxChars,
    ...consolidationDefaults,
  });
}

describe("memory consolidation project groups", () => {
  it("consolidates global and project candidates in deterministic isolated passes", async () => {
    const existingMemory = "# Memory\n\n- Existing global fact.\n";
    const candidates = [
      projectCandidate("beta", "Beta deployment uses blue.", "github.com/acme/beta"),
      projectCandidate("global", "Use metric units globally."),
      projectCandidate("alpha", "Alpha deployment uses green.", "github.com/acme/alpha"),
    ];
    const subagent = createPromptResponder(addDecisions);

    const plan = await consolidate(candidates, existingMemory, subagent);

    const promptedGroups = subagent.complete.mock.calls.map(([options]) => {
      const prompt = JSON.parse((options as { message: string }).message) as ConsolidationPrompt;
      return prompt.candidates.map((item) => item.projectKey);
    });
    expect(promptedGroups).toEqual([[null], ["github.com/acme/alpha"], ["github.com/acme/beta"]]);

    const result = applyMemoryConsolidationPlan({
      existingMemory,
      plan: expectDefined(plan, "consolidation plan"),
      ...planDefaults,
    });
    expect(result?.content).toContain(
      "Alpha deployment uses green. Source: memory/2026-07-01.md#L1-L1 <!-- trigger: preference --> <!-- importance: 9 --> <!-- project: github.com/acme/alpha -->",
    );
    expect(result?.content).toContain(
      "Beta deployment uses blue. Source: memory/2026-07-01.md#L1-L1 <!-- trigger: preference --> <!-- importance: 9 --> <!-- project: github.com/acme/beta -->",
    );
    const globalLine = result?.content
      .split("\n")
      .find((line) => line.includes("Use metric units globally."));
    expect(globalLine).toBeDefined();
    expect(globalLine).not.toContain("<!-- project:");
  });

  it("rejects a cross-project merge after completing the isolated group passes", async () => {
    const betaPrior = "- Shared deployment uses blue. <!-- project: github.com/acme/beta -->";
    const existingMemory = `# Memory\n\n${betaPrior}\n- Two.\n- Three.\n- Four.\n`;
    const candidates = [
      projectCandidate("beta", "Beta deployment uses blue.", "github.com/acme/beta"),
      projectCandidate("global", "Use metric units globally."),
      projectCandidate("alpha", "Shared deployment uses blue.", "github.com/acme/alpha"),
    ];
    const subagent = createPromptResponder((prompt) => {
      const item = prompt.candidates[0]!;
      const crossProject = item.projectKey === "github.com/acme/alpha";
      return {
        operations: [
          {
            candidateKey: item.key,
            action: crossProject ? "merged" : "added",
            priorEntries: crossProject ? [betaPrior] : [],
          },
        ],
      };
    });

    await expect(consolidate(candidates, existingMemory, subagent)).resolves.toBeNull();
    expect(subagent.complete).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("output crosses project groups for candidate alpha"),
    );
  });

  it("rejects groups whose code-applied aggregate exceeds the memory budget", async () => {
    const existingMemory = "# Memory\n";
    const candidates = [
      projectCandidate("global", "Use metric units globally."),
      projectCandidate("alpha", "Alpha deployment uses green.", "github.com/acme/alpha"),
    ];

    const fullPlan = await consolidate(candidates, existingMemory);

    const perGroupBudget = Math.max(
      ...expectDefined(fullPlan, "full consolidation plan").operations.map((operation) => {
        const result = applyMemoryConsolidationPlan({
          existingMemory,
          plan: { operations: [operation] },
          ...planDefaults,
        });
        expect(result).not.toBeNull();
        return result!.content.length;
      }),
    );

    await expect(
      consolidate(candidates, existingMemory, undefined, perGroupBudget),
    ).resolves.toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(
      "memory-core: combined consolidation plan is invalid; using append-only fallback.",
    );
  });
});

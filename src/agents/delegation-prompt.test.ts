import { describe, expect, it } from "vitest";
import { buildDelegationPrompt } from "./delegation-prompt.js";
import { buildSubagentSystemPrompt } from "./subagent-announce.js";

describe("buildDelegationPrompt", () => {
  it("builds Tier 1 prompt with fleet table and Full Orchestrator guidance", () => {
    const prompt = buildDelegationPrompt({
      depth: 1,
      maxDepth: 4,
      parentKey: "agent:main:subagent:parent",
      childSlotsAvailable: 3,
      maxChildrenPerAgent: 4,
      globalSlotsAvailable: 6,
      maxConcurrent: 8,
      fleet: [
        { id: "main", model: "anthropic/claude-sonnet-4", description: "General orchestrator" },
      ],
      providerSlots: [
        { provider: "openai", available: 7, active: 1, pending: 0, total: 1, max: 8 },
      ],
    });

    expect(prompt).toContain("Delegation Tier: Full Orchestrator");
    expect(prompt).toContain("| Agent ID | Model | Description |");
    expect(prompt).not.toContain("## Provider Slots");
  });

  it("builds Tier 2 prompt that marks children as leaf workers", () => {
    const prompt = buildDelegationPrompt({
      depth: 3,
      maxDepth: 4,
      parentKey: "agent:main:subagent:parent",
      childSlotsAvailable: 1,
      maxChildrenPerAgent: 2,
      globalSlotsAvailable: 2,
      maxConcurrent: 8,
      fleet: [{ id: "cheap", model: "openai/gpt-4.1-mini", description: "Budget worker" }],
    });

    expect(prompt).toContain("Delegation Tier: Last Delegator");
    expect(prompt).toContain("leaf workers");
  });

  it("renders provider slots table for delegators", () => {
    const prompt = buildDelegationPrompt({
      depth: 2,
      maxDepth: 4,
      parentKey: "agent:main:subagent:parent",
      childSlotsAvailable: 2,
      maxChildrenPerAgent: 4,
      globalSlotsAvailable: 5,
      maxConcurrent: 8,
      fleet: [{ id: "main", model: "anthropic/claude-sonnet-4", description: "General" }],
      providerSlots: [
        { provider: "google", available: 1, active: 2, pending: 0, total: 2, max: 3 },
        { provider: "openai", available: 6, active: 1, pending: 1, total: 2, max: 8 },
      ],
    });

    expect(prompt).toContain("## Provider Slots");
    expect(prompt).toContain("| Provider | Available | Active | Pending | Used | Max |");
    expect(prompt).toContain("| google | 1 | 2 | 0 | 2 | 3 |");
    expect(prompt).toContain("| openai | 6 | 1 | 1 | 2 | 8 |");
  });

  it("builds Tier 3 prompt with Leaf Worker constraints and no fleet table", () => {
    const prompt = buildDelegationPrompt({
      depth: 4,
      maxDepth: 4,
      parentKey: "agent:main:subagent:parent",
      childSlotsAvailable: 0,
      maxChildrenPerAgent: 2,
      globalSlotsAvailable: 0,
      maxConcurrent: 8,
      fleet: [{ id: "main", model: "anthropic/claude-sonnet-4", description: "General" }],
      providerSlots: [
        { provider: "google", available: 0, active: 2, pending: 1, total: 3, max: 3 },
      ],
    });

    expect(prompt).toContain("Delegation Tier: Leaf Worker");
    expect(prompt).toContain("Complete your task directly. Do not attempt to spawn subagents.");
    expect(prompt).not.toContain("## Provider Slots");
    expect(prompt).not.toContain("| Agent ID | Model | Description |");
  });

  it("renders fleet table rows with id, model, and description", () => {
    const prompt = buildDelegationPrompt({
      depth: 1,
      maxDepth: 3,
      parentKey: "agent:main:subagent:parent",
      childSlotsAvailable: 2,
      maxChildrenPerAgent: 4,
      globalSlotsAvailable: 4,
      maxConcurrent: 8,
      fleet: [
        { id: "main", model: "anthropic/claude-opus-4", description: "Plans and routes" },
        { id: "worker", model: "openai/gpt-4.1-mini", description: "Implements fixes" },
      ],
    });

    expect(prompt).toContain("| main | anthropic/claude-opus-4 | Plans and routes |");
    expect(prompt).toContain("| worker | openai/gpt-4.1-mini | Implements fixes |");
  });
});

describe("buildSubagentSystemPrompt", () => {
  it("does not append delegation block for depth-1 subagents", () => {
    const prompt = buildSubagentSystemPrompt({
      requesterSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:depth1",
      task: "Do one scoped task",
    });

    expect(prompt).toContain("# Subagent Context");
    expect(prompt).not.toContain("## Delegation Tier:");
  });
});

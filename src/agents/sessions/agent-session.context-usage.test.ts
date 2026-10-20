import { describe, expect, it } from "vitest";
import type { Usage } from "../../llm/types.js";
import type { AgentMessage } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import { AgentSession } from "./agent-session.js";

function measuredUsage(input: number, output = 0) {
  return {
    ...createZeroUsageFixture(),
    input,
    output,
    totalTokens: input + output,
    contextUsage: { state: "available" as const, promptTokens: input, totalTokens: input + output },
  };
}

const compaction = {
  type: "compaction",
  id: "compact-1",
  parentId: null,
  timestamp: "2026-07-05T00:00:00.000Z",
  summary: "summary",
  firstKeptEntryId: "assistant-exact",
  tokensBefore: 120_000,
};

function messageEntry(id: string, message: AgentMessage) {
  return { type: "message", id, parentId: "compact-1", message };
}

function assistant(text: string, usage: Usage) {
  return makeAgentAssistantMessage({ content: text ? [{ type: "text", text }] : [], usage });
}

function getUsage(messages: AgentMessage[], branchEntries: unknown[], contextWindow = 200_000) {
  return AgentSession.prototype.getContextUsage.call({
    model: { contextWindow },
    messages,
    sessionManager: { getBranch: () => branchEntries },
  } as unknown as AgentSession);
}

describe("AgentSession context usage", () => {
  it("reports unknown usage after a provider checkpoint until a later measured response", () => {
    const owner = assistant("covered", measuredUsage(90_000));
    owner.providerReplay = {
      v: 1,
      type: "openai-responses-retained-compaction",
      data: "opaque",
      provider: owner.provider,
      api: owner.api,
      model: owner.model,
      baseUrlHash: "hash",
    };
    const messages: AgentMessage[] = [owner];
    const branchEntries = [messageEntry("checkpoint-owner", owner)];
    expect(getUsage(messages, branchEntries, 100_000)).toEqual({
      tokens: null,
      contextWindow: 100_000,
      percent: null,
    });
    const later = assistant("later", measuredUsage(8_000));
    messages.push(later);
    branchEntries.push(messageEntry("later", later));
    expect(getUsage(messages, branchEntries, 100_000)?.tokens).toBe(8_000);
  });

  it.each([
    {
      name: "unavailable usage before any compaction",
      compacted: false,
      usage: {
        ...createZeroUsageFixture(),
        input: 12,
        output: 8,
        cacheRead: 180_000,
        totalTokens: 180_020,
        contextUsage: { state: "unavailable" as const },
      },
    },
    {
      name: "unavailable usage after compaction",
      compacted: true,
      usage: { ...measuredUsage(180_000, 10_000), contextUsage: { state: "unavailable" as const } },
    },
    { name: "zero usage after compaction", compacted: true, usage: measuredUsage(0) },
  ])("preserves an earlier exact snapshot before $name", ({ compacted, usage: latestUsage }) => {
    const exact = assistant("exact answer", measuredUsage(180_000, 10_000));
    const later = assistant(latestUsage.totalTokens === 0 ? "" : "small answer", latestUsage);
    const messages: AgentMessage[] = [
      exact,
      { role: "user", content: "small follow-up", timestamp: 1 },
      later,
    ];
    const branchEntries = compacted
      ? [compaction, messageEntry("assistant-exact", exact), messageEntry("assistant-later", later)]
      : [];
    const usage = getUsage(messages, branchEntries);

    expect(usage?.tokens).toBeGreaterThan(190_000);
  });

  it("uses a content estimate after compaction when provider context usage is unavailable", () => {
    const unavailableUsage = {
      ...createZeroUsageFixture(),
      input: 12,
      output: 15_104,
      cacheRead: 819_661,
      cacheWrite: 93_130,
      totalTokens: 927_907,
      contextUsage: { state: "unavailable" as const },
    };
    const retained = assistant("retained answer", {
      ...unavailableUsage,
      contextUsage: { state: "available", promptTokens: 120_000, totalTokens: 125_000 },
    });
    const later = assistant("new answer", unavailableUsage);
    const messages: AgentMessage[] = [
      retained,
      { role: "user", content: "new prompt", timestamp: 1 },
      later,
    ];
    const branchEntries = [compaction, messageEntry("assistant-new", later)];
    const usage = getUsage(messages, branchEntries);

    expect(usage?.tokens).not.toBeNull();
    expect(usage?.tokens).toBeLessThan(1_000);
  });
});

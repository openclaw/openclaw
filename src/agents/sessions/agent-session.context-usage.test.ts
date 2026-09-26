import { describe, expect, it } from "vitest";
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

describe("AgentSession context usage", () => {
  it("reports unknown usage after a provider checkpoint until a later measured response", () => {
    const owner = makeAgentAssistantMessage({
      content: [{ type: "text", text: "covered" }],
      usage: measuredUsage(90_000),
    });
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
    const session = {
      model: { contextWindow: 100_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession;
    expect(AgentSession.prototype.getContextUsage.call(session)).toEqual({
      tokens: null,
      contextWindow: 100_000,
      percent: null,
    });
    const later = makeAgentAssistantMessage({
      content: [{ type: "text", text: "later" }],
      usage: measuredUsage(8_000),
    });
    messages.push(later);
    branchEntries.push(messageEntry("later", later));
    expect(AgentSession.prototype.getContextUsage.call(session)?.tokens).toBe(8_000);
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
    const exact = makeAgentAssistantMessage({
      content: [{ type: "text", text: "exact answer" }],
      usage: measuredUsage(180_000, 10_000),
    });
    const later = makeAgentAssistantMessage({
      content: latestUsage.totalTokens === 0 ? [] : [{ type: "text", text: "small answer" }],
      usage: latestUsage,
    });
    const messages: AgentMessage[] = [
      exact,
      { role: "user", content: "small follow-up", timestamp: 1 },
      later,
    ];
    const branchEntries = compacted
      ? [compaction, messageEntry("assistant-exact", exact), messageEntry("assistant-later", later)]
      : [];
    const usage = AgentSession.prototype.getContextUsage.call({
      model: { contextWindow: 200_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession);

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
    const retained = makeAgentAssistantMessage({
      content: [{ type: "text", text: "retained answer" }],
      usage: {
        ...unavailableUsage,
        contextUsage: { state: "available", promptTokens: 120_000, totalTokens: 125_000 },
      },
    });
    const later = makeAgentAssistantMessage({
      content: [{ type: "text", text: "new answer" }],
      usage: unavailableUsage,
    });
    const messages: AgentMessage[] = [
      retained,
      { role: "user", content: "new prompt", timestamp: 1 },
      later,
    ];
    const branchEntries = [compaction, messageEntry("assistant-new", later)];
    const usage = AgentSession.prototype.getContextUsage.call({
      model: { contextWindow: 200_000 },
      messages,
      sessionManager: { getBranch: () => branchEntries },
    } as unknown as AgentSession);

    expect(usage?.tokens).not.toBeNull();
    expect(usage?.tokens).toBeLessThan(1_000);
  });
});

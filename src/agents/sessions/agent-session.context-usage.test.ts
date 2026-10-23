import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
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

function unavailable(input: number, output: number, cacheRead = 0, cacheWrite = 0): Usage {
  return {
    ...createZeroUsageFixture(),
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    contextUsage: { state: "unavailable" },
  };
}

const compaction = { type: "compaction" };

function messageEntry(message: AgentMessage) {
  return { type: "message", message };
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
  const branchEntries = [messageEntry(owner)];
  expect(getUsage(messages, branchEntries, 100_000)).toEqual({
    tokens: null,
    contextWindow: 100_000,
    percent: null,
  });
  const later = assistant("later", measuredUsage(8_000));
  messages.push(later);
  branchEntries.push(messageEntry(later));
  expect(getUsage(messages, branchEntries, 100_000)?.tokens).toBe(8_000);
});

it.each([
  [false, unavailable(12, 8, 180_000)],
  [true, unavailable(180_000, 10_000)],
  [true, measuredUsage(0)],
] as const)(
  "preserves an earlier exact snapshot (compacted=%s, latest=%j)",
  (compacted, latestUsage) => {
    const exact = assistant("exact answer", measuredUsage(180_000, 10_000));
    const later = assistant(latestUsage.totalTokens === 0 ? "" : "small answer", latestUsage);
    const messages: AgentMessage[] = [exact, makeUserMessage("small follow-up", 1), later];
    const branchEntries = compacted ? [compaction, messageEntry(exact), messageEntry(later)] : [];
    const usage = getUsage(messages, branchEntries);

    expect(usage?.tokens).toBeGreaterThan(190_000);
  },
);

it("uses a content estimate after compaction when provider context usage is unavailable", () => {
  const unavailableUsage = unavailable(12, 15_104, 819_661, 93_130);
  const retained = assistant("retained answer", {
    ...unavailableUsage,
    contextUsage: { state: "available", promptTokens: 120_000, totalTokens: 125_000 },
  });
  const later = assistant("new answer", unavailableUsage);
  const messages: AgentMessage[] = [retained, makeUserMessage("new prompt", 1), later];
  const branchEntries = [compaction, messageEntry(later)];
  const usage = getUsage(messages, branchEntries);

  expect(usage?.tokens).not.toBeNull();
  expect(usage?.tokens).toBeLessThan(1_000);
});

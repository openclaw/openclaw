import { expect, it } from "vitest";
import type { AgentMessage } from "../runtime/index.js";
import {
  makeAgentAssistantMessage,
  makeAgentUserMessage,
} from "../test-helpers/agent-message-fixtures.js";
import {
  buildBeforeCompactionHookMetrics,
  estimateTokensAfterCompaction,
} from "./compaction-hook-metrics.js";

it("treats pre-compaction token estimation failures as a no-op sanity check", () => {
  const keptMessage = makeAgentUserMessage({ content: "kept ask" });
  const messages = [
    keptMessage,
    makeAgentAssistantMessage({ content: [{ type: "text", text: "legacy reply" }] }),
  ];
  const estimateTokens = (message: AgentMessage) => {
    if (message.role === "assistant") {
      throw new Error("legacy message");
    }
    return 30;
  };
  const beforeMetrics = buildBeforeCompactionHookMetrics({
    originalMessages: messages,
    currentMessages: messages,
    estimateTokensFn: estimateTokens,
  });
  const tokensAfter = estimateTokensAfterCompaction({
    messagesAfter: [keptMessage],
    fullSessionTokensBefore: 0,
    estimateTokensFn: estimateTokens,
  });

  expect(beforeMetrics).toMatchObject({
    tokenCountOriginal: undefined,
    tokenCountBefore: undefined,
  });
  expect(tokensAfter).toBe(30);
});

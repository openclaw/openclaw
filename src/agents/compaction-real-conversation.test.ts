import { describe, expect, it } from "vitest";
import {
  createRealConversationClassifier,
  isRealConversationMessage,
} from "./compaction-real-conversation.js";
import type { AgentMessage } from "./runtime/index.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { textToolResult } from "./test-helpers/sparse-transcript.test-support.js";

type SummaryRole = "branchSummary" | "compactionSummary";

function summaryMessage(role: SummaryRole, summary: string): AgentMessage {
  return { role, summary, timestamp: 1 } as AgentMessage;
}

describe("compaction real conversation classification", () => {
  it("expires streaming tool-result anchors after the 20-message lookback", () => {
    const classify = createRealConversationClassifier();
    expect(classify({ role: "user", content: "Inspect the repo", timestamp: 1 })).toBe(true);
    const silent = makeAgentAssistantMessage({
      content: [{ type: "text", text: "NO_REPLY" }],
    });
    for (let index = 0; index < 19; index += 1) {
      expect(classify(silent)).toBe(false);
    }
    const result = textToolResult("call-1", "read", "package.json") as AgentMessage;
    expect(classify(result)).toBe(true);
    expect(classify(result)).toBe(false);
  });

  it.each(["NO_REPLY.", '"NO_REPLY"', '{"action":"NO_REPLY"}', "no_reply", "Done\nNO_REPLY"])(
    "counts literal assistant text %s as conversation",
    (text) => {
      const message = makeAgentAssistantMessage({ content: [{ type: "text", text }] });
      expect(isRealConversationMessage(message, [message], 0)).toBe(true);
    },
  );

  it("counts user NO_REPLY as conversation", () => {
    const message: AgentMessage = { role: "user", content: "NO_REPLY", timestamp: 1 };
    expect(isRealConversationMessage(message, [message], 0)).toBe(true);
  });

  it.each<SummaryRole>(["compactionSummary"])(
    "treats non-empty %s messages as conversation anchors",
    (role) => {
      const summary = summaryMessage(role, "The user asked for a repository audit.");
      const toolResult = textToolResult("call-1", "exec", "audit output") as AgentMessage;
      const messages = [summary, toolResult];

      expect(isRealConversationMessage(summary, messages, 0)).toBe(true);
      expect(isRealConversationMessage(toolResult, messages, 1)).toBe(true);
    },
  );

  it.each([
    { excludeFromContext: true, expected: false },
    { excludeFromContext: false, expected: true },
  ])(
    "classifies custom conversation according to context eligibility ($excludeFromContext)",
    ({ excludeFromContext, expected }) => {
      const custom = {
        role: "custom",
        customType: "display-note",
        content: "A visible administrative event.",
        display: true,
        excludeFromContext,
        timestamp: 1,
      } satisfies AgentMessage;
      const toolResult = textToolResult("call-1", "exec", "audit output") as AgentMessage;
      const messages = [custom, toolResult];

      expect(isRealConversationMessage(custom, messages, 0)).toBe(expected);
      expect(isRealConversationMessage(toolResult, messages, 1)).toBe(expected);
    },
  );

  it.each([["thinking-only blocks", [{ type: "thinking", thinking: "checking" }]]])(
    "rejects assistant %s as conversation",
    (_name, content) => {
      const message = { role: "assistant", content } as AgentMessage;

      expect(isRealConversationMessage(message, [message], 0)).toBe(false);
    },
  );

  it.each([
    {
      name: "heartbeat-only user turn",
      preceding: [{ role: "user", content: "<b>HEARTBEAT_OK</b>" }],
      expected: false,
    },
  ])("classifies tool output after a $name", ({ preceding, expected }) => {
    const toolResult = textToolResult("call-1", "exec", "checked") as AgentMessage;
    const messages = [...preceding, toolResult] as AgentMessage[];

    expect(isRealConversationMessage(toolResult, messages, preceding.length)).toBe(expected);
  });
});

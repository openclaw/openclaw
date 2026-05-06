import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  hasMeaningfulConversationContent,
  isRealConversationMessage,
} from "./compaction-real-conversation.js";

const m = (msg: Record<string, unknown>): AgentMessage => msg as unknown as AgentMessage;

describe("hasMeaningfulConversationContent — bashExecution role", () => {
  it("returns true when command and output carry meaningful text", () => {
    expect(
      hasMeaningfulConversationContent(
        m({ role: "bashExecution", command: "ls -la", output: "total 4\n" }),
      ),
    ).toBe(true);
  });

  it("short-circuits to false when excludeFromContext is true, even with meaningful command/output", () => {
    expect(
      hasMeaningfulConversationContent(
        m({
          role: "bashExecution",
          command: "ls -la",
          output: "total 4\n",
          excludeFromContext: true,
        }),
      ),
    ).toBe(false);
  });

  it("returns false when both command and output are empty", () => {
    expect(
      hasMeaningfulConversationContent(m({ role: "bashExecution", command: "", output: "" })),
    ).toBe(false);
  });

  it("returns false when command and output are missing entirely (non-string)", () => {
    expect(hasMeaningfulConversationContent(m({ role: "bashExecution" }))).toBe(false);
  });
});

describe("hasMeaningfulConversationContent — branchSummary role", () => {
  it("returns true when summary is a non-empty string with meaningful text", () => {
    expect(
      hasMeaningfulConversationContent(
        m({ role: "branchSummary", summary: "Investigated panel A; nothing reproduced." }),
      ),
    ).toBe(true);
  });

  it("returns false when summary is an empty string", () => {
    expect(hasMeaningfulConversationContent(m({ role: "branchSummary", summary: "" }))).toBe(false);
  });

  it("returns false when summary is whitespace-only", () => {
    expect(hasMeaningfulConversationContent(m({ role: "branchSummary", summary: "   \n  " }))).toBe(
      false,
    );
  });

  it("returns false when summary is not a string (object)", () => {
    expect(
      hasMeaningfulConversationContent(
        m({ role: "branchSummary", summary: { stub: true } as unknown }),
      ),
    ).toBe(false);
  });

  it("returns false when summary is missing", () => {
    expect(hasMeaningfulConversationContent(m({ role: "branchSummary" }))).toBe(false);
  });
});

describe("isRealConversationMessage — toolResult anchor lookback", () => {
  const userAnchor = m({ role: "user", content: "what's the disk usage?" });
  const bashAnchor = m({ role: "bashExecution", command: "df -h", output: "/dev/sda1 80%" });
  const branchAnchor = m({ role: "branchSummary", summary: "Branch closed: nothing repro." });
  const reasoning = m({
    role: "assistant",
    content: [{ type: "reasoning", text: "thinking..." }],
  });
  const toolResult = m({ role: "toolResult", content: "result-payload" });

  it("returns true when an anchor sits within the 20-message lookback window", () => {
    const messages = [bashAnchor, reasoning, reasoning, toolResult];
    expect(isRealConversationMessage(toolResult, messages, 3)).toBe(true);
  });

  it("returns true when a branchSummary anchor precedes within the lookback window", () => {
    const messages = [branchAnchor, toolResult];
    expect(isRealConversationMessage(toolResult, messages, 1)).toBe(true);
  });

  it("returns false when no anchor exists in the prior window", () => {
    const messages = [reasoning, reasoning, reasoning, toolResult];
    expect(isRealConversationMessage(toolResult, messages, 3)).toBe(false);
  });

  it("returns false when the only anchor is older than the 20-message lookback window", () => {
    const filler = Array.from({ length: 21 }, () => reasoning);
    const messages = [userAnchor, ...filler, toolResult];
    expect(isRealConversationMessage(toolResult, messages, messages.length - 1)).toBe(false);
  });
});

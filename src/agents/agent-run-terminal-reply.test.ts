import { describe, expect, it } from "vitest";
import { prepareAgentRunTerminalReply } from "./agent-run-terminal-reply.js";

describe("prepareAgentRunTerminalReply", () => {
  it.each([
    ["answer\n\nNO_REPLY", "answer"],
    ["answer\r\n \tNO_REPLY \t\r\n\r\n", "answer"],
    ["answer\rNO_REPLY", "answer"],
    ["NO_REPLY\nanswer", "answer"],
    ["NO_REPLY\nNO_REPLY", "NO_REPLY"],
    ["Mention NO_REPLY in an answer.", "Mention NO_REPLY in an answer."],
    ["answer\nNO_REPLY\nMore", "answer\nNO_REPLY\nMore"],
    ["answer NO_REPLY", "answer NO_REPLY"],
    ["answer\nNO_REPLY.", "answer\nNO_REPLY."],
    ["answer\nno_reply", "answer\nno_reply"],
  ])("prepares %j without reclassifying visible text", (rawText, text) => {
    expect(prepareAgentRunTerminalReply({ rawText })).toEqual({
      text,
      terminalReply: { disposition: "visible", text },
    });
  });

  it("keeps a whole-reply token silent", () => {
    expect(prepareAgentRunTerminalReply({ rawText: " \tNO_REPLY\n\n" })).toEqual({
      text: "",
      terminalReply: { disposition: "silent" },
    });
  });

  it("keeps full prepared text separate from bounded, sanitized terminal evidence", () => {
    const text = `[Mon 2026-01-01 12:00 UTC] ${"A".repeat(5_000)}`;
    expect(prepareAgentRunTerminalReply({ rawText: `NO_REPLY\n${text}` })).toEqual({
      text,
      terminalReply: { disposition: "visible", text: `${"A".repeat(4_095)}…` },
    });
  });
});

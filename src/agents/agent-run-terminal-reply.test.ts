import { describe, expect, it } from "vitest";
import {
  filterAgentRunTerminalPayloadsForPresentation,
  prepareAgentRunTerminalReply,
} from "./agent-run-terminal-reply.js";

describe("prepareAgentRunTerminalReply", () => {
  it.each([
    {
      name: "an acknowledgement-only message",
      payload: { text: "HEARTBEAT_OK" },
      isHeartbeatTrigger: false,
      visible: false,
    },
    {
      name: "visible text beside the acknowledgement",
      payload: { text: "HEARTBEAT_OK Everything is ready." },
      isHeartbeatTrigger: false,
      visible: true,
    },
    {
      name: "media beside the acknowledgement",
      payload: { text: "HEARTBEAT_OK", mediaUrl: "https://example.invalid/chart.png" },
      isHeartbeatTrigger: false,
      visible: true,
    },
    {
      name: "multiple media beside the acknowledgement",
      payload: {
        text: "HEARTBEAT_OK",
        mediaUrl: "  ",
        mediaUrls: ["  ", "https://example.invalid/chart.png"],
      },
      isHeartbeatTrigger: false,
      visible: true,
    },
    {
      name: "a real heartbeat acknowledgement",
      payload: { text: "HEARTBEAT_OK" },
      isHeartbeatTrigger: true,
      visible: true,
    },
  ])("projects $name through message presentation", ({ payload, isHeartbeatTrigger, visible }) => {
    expect(
      filterAgentRunTerminalPayloadsForPresentation({
        payloads: [payload],
        isHeartbeatTrigger,
      }),
    ).toEqual(visible ? [payload] : []);
  });

  it.each([
    ["answer\n\nNO_REPLY", "answer"],
    ["answer\r\n \tNO_REPLY \t\r\n\r\n", "answer"],
    ["answer\rNO_REPLY", "answer"],
    ["NO_REPLY\nanswer", "answer"],
    ["NO_REPLY\nNO_REPLY", "NO_REPLY"],
    ["no_reply\nanswer", "answer"],
    ["answer\nNo_Reply", "answer"],
    ["no_reply\nNo_Reply", "No_Reply"],
    ["Mention NO_REPLY in an answer.", "Mention NO_REPLY in an answer."],
    ["answer\nNO_REPLY\nMore", "answer\nNO_REPLY\nMore"],
    ["answer NO_REPLY", "answer NO_REPLY"],
    ["answer\nNO_REPLY.", "answer\nNO_REPLY."],
    ["Mention no_reply in an answer.", "Mention no_reply in an answer."],
    ["answer\nNo_Reply.", "answer\nNo_Reply."],
  ])("prepares %j without reclassifying visible text", (rawText, text) => {
    expect(prepareAgentRunTerminalReply({ rawText })).toEqual({
      text,
      terminalReply: { disposition: "visible", text },
    });
  });

  it.each(["NO_REPLY", "no_reply", "No_Reply"])("keeps a whole-reply %s silent", (token) => {
    expect(prepareAgentRunTerminalReply({ rawText: ` \t${token}\n\n` })).toEqual({
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

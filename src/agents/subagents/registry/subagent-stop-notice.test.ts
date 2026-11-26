import { afterEach, describe, expect, it } from "vitest";
import { peekSystemEvents, resetSystemEventsForTest } from "../../../infra/system-events.js";
import { enqueueStoppedSubagentsNotice } from "./subagent-stop-notice.js";

const sessionKey = "agent:main:main";
const PLURAL_TAIL =
  "They won't report back. Check their sessions before relying on any partial work, " +
  "and don't restart them unless the user asks.";

afterEach(() => resetSystemEventsForTest());

describe("enqueueStoppedSubagentsNotice", () => {
  it.each([
    {
      name: "uses the singular sentence for one child",
      killed: 1,
      labels: ["slow-a"],
      text:
        "A user /stop command canceled 1 running sub-agent: slow-a. It won't report back. " +
        "Check its session before relying on any partial work, and don't restart it unless the user asks.",
    },
    {
      name: "skips labels that are empty after trimming",
      killed: 2,
      labels: ["  ", "slow-b"],
      text: `A user /stop command canceled 2 running sub-agents: slow-b and 1 more. ${PLURAL_TAIL}`,
    },
    {
      name: "counts unnamed children after a single name without a comma",
      killed: 3,
      labels: ["slow-a"],
      text: `A user /stop command canceled 3 running sub-agents: slow-a and 2 more. ${PLURAL_TAIL}`,
    },
    {
      name: "keeps the comma after two or more names",
      killed: 3,
      labels: ["slow-a", "slow-b"],
      text: `A user /stop command canceled 3 running sub-agents: slow-a, slow-b, and 1 more. ${PLURAL_TAIL}`,
    },
  ])("$name", ({ killed, labels, text }) => {
    enqueueStoppedSubagentsNotice({
      source: "channel-user",
      requesterSessionKey: sessionKey,
      requesterAgentId: "main",
      killed,
      labels,
    });
    expect(peekSystemEvents(sessionKey)).toEqual([text]);
  });
});

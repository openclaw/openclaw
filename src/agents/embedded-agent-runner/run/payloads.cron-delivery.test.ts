import { describe, expect, it } from "vitest";
import { buildPayloads } from "./payloads.test-helpers.js";

describe("cron completion after a delivered report", () => {
  const deliveredReport = {
    tool: "message",
    provider: "slack",
    to: "C_REPORTS",
    text: "The daily report is complete.",
  };
  const completedRun = {
    isCronTrigger: true,
    assistantTexts: ["NO_REPLY"],
    didSendViaMessagingTool: true,
    messagingToolSentTargets: [deliveredReport],
    lastToolError: {
      toolName: "codex_apps.slack.slack_read_thread",
      error: "429 RATE_LIMITED",
      mutatingAction: false,
    },
  };

  it.each([true, undefined])(
    "does not replace a delivered report with a failed verification read (final=%s)",
    (sourceReplyFinal) => {
      expect(
        buildPayloads({
          ...completedRun,
          messagingToolSentTargets: [{ ...deliveredReport, sourceReplyFinal }],
        }),
      ).toEqual([]);
    },
  );

  it.each([
    { name: "an unconfirmed send", messagingToolSentTargets: [] },
    {
      name: "an explicitly progress-only send",
      messagingToolSentTargets: [{ ...deliveredReport, sourceReplyFinal: false }],
    },
    {
      name: "a send without visible content",
      messagingToolSentTargets: [{ ...deliveredReport, text: "", visible: false }],
    },
    { name: "an aborted run", runAborted: true },
    { name: "a run without a final answer", assistantTexts: [] },
    { name: "a heartbeat", isHeartbeatTrigger: true },
  ])("still reports failure for $name", ({ name: _name, ...overrides }) => {
    expect(buildPayloads({ ...completedRun, ...overrides })).toEqual([
      expect.objectContaining({ isError: true }),
    ]);
  });
});

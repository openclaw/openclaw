import { describe, expect, it } from "vitest";
import { projectAgentActivityItem } from "./agent-activity-presentation.js";

const messageCall = (status: "running" | "completed" | "failed") => ({
  itemId: "tool:call-1",
  kind: "tool",
  name: "message",
  status,
});

const send = { action: "send", message: "Hi!" };
const sentHere = {
  deliveryStatus: "sent",
  sourceReplySink: "internal-ui",
  sourceReply: { text: "Hi!" },
};

describe("message tool activity", () => {
  it.each([true, false])("hides a delivered current-chat reply (final=%s)", (final) => {
    expect(
      projectAgentActivityItem(messageCall("completed"), {
        args: { ...send, final },
        result: { details: sentHere },
      }),
    ).toHaveProperty("hideFromChannelProgress", true);
  });

  it.each([{}, { to: "C999" }, { channelId: "C999" }, { channel: "slack", target: "C999" }])(
    "keeps sends visible before delivery and without a current-chat receipt: %j",
    (destination) => {
      const args = { ...send, ...destination };
      expect(projectAgentActivityItem(messageCall("running"), { args })).not.toHaveProperty(
        "hideFromChannelProgress",
      );
      expect(
        projectAgentActivityItem(messageCall("completed"), {
          args,
          result: { details: { deliveryStatus: "sent" } },
        }),
      ).not.toHaveProperty("hideFromChannelProgress");
    },
  );

  it.each(["dry_run", "failed", "partial_failed", "suppressed"])(
    "keeps %s results visible even if they contain the source-reply payload",
    (deliveryStatus) => {
      expect(
        projectAgentActivityItem(messageCall("completed"), {
          args: send,
          result: { details: { ...sentHere, deliveryStatus } },
        }),
      ).not.toHaveProperty("hideFromChannelProgress");
    },
  );

  it("keeps failed tool calls visible", () => {
    expect(projectAgentActivityItem(messageCall("failed"), { args: send })).not.toHaveProperty(
      "hideFromChannelProgress",
    );
  });
});

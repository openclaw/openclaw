import { describe, expect, it } from "vitest";
import { projectAgentActivityItem } from "./agent-activity-presentation.js";

const messageCall = (status: "running" | "completed" | "failed") => ({
  itemId: "tool:call-1",
  kind: "tool",
  name: "message",
  status,
});

describe("message tool activity", () => {
  it("hides a reply sent to its source conversation, where the reply itself is shown", () => {
    expect(
      projectAgentActivityItem(messageCall("running"), {
        args: { action: "send", final: false, message: "Hi!" },
      }),
    ).toMatchObject({ hideFromChannelProgress: true });
    expect(
      projectAgentActivityItem(messageCall("completed"), {
        args: { action: "send", final: false, message: "Hi!" },
        result: { details: { status: "ok", sourceReply: { text: "Hi!" } } },
      }),
    ).toMatchObject({ hideFromChannelProgress: true });
  });

  it("keeps a send to another conversation and a failed source reply visible", () => {
    expect(
      projectAgentActivityItem(messageCall("completed"), {
        args: { action: "send", channel: "slack", target: "C123", message: "Deployed" },
        result: { details: { status: "ok" } },
      }),
    ).not.toHaveProperty("hideFromChannelProgress");
    expect(
      projectAgentActivityItem(messageCall("failed"), {
        args: { action: "send", message: "Hi!" },
      }),
    ).not.toHaveProperty("hideFromChannelProgress");
  });
});

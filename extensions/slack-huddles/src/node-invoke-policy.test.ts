import { describe, expect, it, vi } from "vitest";
import { slackHuddlesConfig } from "./config.js";
import { createSlackHuddlesNodeInvokePolicy } from "./node-invoke-policy.js";

describe("Slack huddles node invoke policy", () => {
  it("normalizes channel input and forwards only configured audio commands", async () => {
    const config = slackHuddlesConfig.resolveConfig({
      chrome: {
        audioInputCommand: ["trusted-input"],
        audioOutputCommand: ["trusted-output"],
      },
    });
    const invokeNode = vi.fn(async () => ({ ok: true as const }));
    const policy = createSlackHuddlesNodeInvokePolicy(config);
    const result = await policy.handle({
      command: "slackhuddles.chrome",
      config: {},
      invokeNode,
      nodeId: "node-1",
      params: {
        action: "start",
        url: "channel:C0123ABCD",
        mode: "transcribe",
        audioInputCommand: ["untrusted-input"],
        audioOutputCommand: ["untrusted-output"],
      },
    });
    expect(result).toEqual({ ok: true });
    expect(invokeNode).toHaveBeenCalledOnce();
    expect(invokeNode).toHaveBeenCalledWith({
      params: expect.objectContaining({
        action: "start",
        url: "https://app.slack.com/huddle/C0123ABCD",
        mode: "transcribe",
        audioInputCommand: ["trusted-input"],
        audioOutputCommand: ["trusted-output"],
      }),
    });
  });

  it("rejects a Slack message permalink before invoking the paired node", async () => {
    const invokeNode = vi.fn(async () => ({ ok: true as const }));
    const policy = createSlackHuddlesNodeInvokePolicy(slackHuddlesConfig.resolveConfig({}));
    expect(
      await policy.handle({
        command: "slackhuddles.chrome",
        config: {},
        invokeNode,
        nodeId: "node-1",
        params: { action: "start", url: "https://app.slack.com/archives/C0123ABCD/p1234567890" },
      }),
    ).toMatchObject({ ok: false, code: "SLACK_HUDDLES_NODE_POLICY_DENIED" });
    expect(invokeNode).not.toHaveBeenCalled();
  });
});

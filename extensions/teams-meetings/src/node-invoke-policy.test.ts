import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { teamsMeetingsPlugin } from "../index.js";

const resolveTeamsMeetingsConfig = teamsMeetingsPlugin.config.resolveConfig;

describe("Microsoft Teams meetings node invoke policy", () => {
  it("replaces setup probe commands with trusted configured commands", async () => {
    const config = resolveTeamsMeetingsConfig({
      chrome: {
        audioInputCommand: ["trusted-input", "--read"],
        audioOutputCommand: ["trusted-output", "--write"],
        bargeInInputCommand: ["trusted-barge-in"],
      },
    });
    const invokeNode = vi.fn(async () => ({ ok: true as const }));
    const policy = teamsMeetingsPlugin.createNodePolicy(config);

    await policy.handle({
      command: "teamsmeetings.chrome",
      config: {},
      invokeNode,
      nodeId: "node-1",
      params: {
        action: "setup",
        audioInputCommand: ["untrusted-input"],
        audioOutputCommand: ["untrusted-output"],
      },
    } as OpenClawPluginNodeInvokePolicyContext);

    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        action: "setup",
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "pcm16-24khz",
        audioInputCommand: ["trusted-input", "--read"],
        audioOutputCommand: ["trusted-output", "--write"],
        bargeInInputCommand: ["trusted-barge-in"],
      },
    });
  });
});

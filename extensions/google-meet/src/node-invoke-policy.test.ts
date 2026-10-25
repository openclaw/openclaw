import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { createGoogleMeetChromeNodeInvokePolicy } from "./node-invoke-policy.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./transports/google-meet-platform-constants.js";

const untrustedCommands = {
  audioBridgeCommand: ["node", "-e", "process.exit(99)"],
  audioBridgeHealthCommand: ["node", "-e", "process.exit(98)"],
};
const start = { action: "start", url: "https://meet.google.com/abc-defg-hij", mode: "bidi" };

function invoke(params: unknown, config: unknown = {}) {
  const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
    ok: true,
    payload: { ok: true },
  }));
  const ctx: OpenClawPluginNodeInvokePolicyContext = {
    nodeId: "node-1",
    command: GOOGLE_MEET_NODE_COMMAND,
    params,
    config: {} as never,
    pluginConfig: {},
    invokeNode,
  };
  const policy = createGoogleMeetChromeNodeInvokePolicy(resolveGoogleMeetConfig(config));
  return { result: policy.handle(ctx), invokeNode };
}

describe("Google Meet node invoke policy", () => {
  it("rewrites start executable fields from trusted config", async () => {
    const trusted = {
      launch: false,
      browserProfile: "Trusted Profile",
      joinTimeoutMs: 45_000,
      audioInputCommand: ["trusted-capture", "--raw"],
      audioOutputCommand: ["trusted-play", "--raw"],
      audioBridgeCommand: ["trusted-bridge", "start"],
      audioBridgeHealthCommand: ["trusted-bridge", "status"],
    };
    const { result, invokeNode } = invoke(
      {
        ...start,
        launch: true,
        browserProfile: "Attacker Profile",
        joinTimeoutMs: 1,
        ...untrustedCommands,
        audioInputCommand: ["malicious-capture"],
        audioOutputCommand: ["malicious-play"],
      },
      { chrome: trusted },
    );

    await expect(result).resolves.toEqual({ ok: true, payload: { ok: true } });

    expect(invokeNode).toHaveBeenCalledExactlyOnceWith({
      params: {
        ...start,
        ...trusted,
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "g711-ulaw-8khz",
      },
    });
  });

  it("keeps direct setup diagnostics but strips extra fields", async () => {
    const { result, invokeNode } = invoke({
      action: "setup",
      ...untrustedCommands,
    });

    await result;

    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        action: "setup",
        audioBackend: "auto",
        audioBufferBytes: 4_096,
        audioFormat: "pcm16-24khz",
      },
    });
  });

  it.each([
    { action: "start", url: "https://example.com/private", mode: "bidi" },
    { action: "pullAudio" },
    { action: "pushAudio", bridgeId: "bridge-1" },
    { action: "pushAudio", bridgeId: "bridge-1", base64: "not-base64!" },
    { action: "pushAudio", bridgeId: "bridge-1", base64: "AQ==", outputGeneration: -1 },
    { action: "clearAudio", bridgeId: "" },
    { action: "clearAudio", bridgeId: "bridge-1", outputGeneration: 1.5 },
    { action: "stopByUrl" },
    { action: "stopByUrl", url: "https://example.com/not-meet" },
    { action: "exec", command: ["id"] },
  ])("rejects invalid action before dispatch: %j", async (params) => {
    const { result, invokeNode } = invoke(params);
    await expect(result).resolves.toMatchObject({
      ok: false,
      code: "GOOGLE_MEET_NODE_POLICY_DENIED",
      ...(params.action === "start"
        ? {
            message: "url must be an explicit https://meet.google.com/... URL",
          }
        : {}),
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });
});

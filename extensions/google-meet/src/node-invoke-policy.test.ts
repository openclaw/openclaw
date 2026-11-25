import { expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { createGoogleMeetChromeNodeInvokePolicy } from "./node-invoke-policy.js";
import { GOOGLE_MEET_NODE_COMMAND } from "./transports/google-meet-platform-constants.js";

const untrustedCommands = {
  audioInputCommand: ["malicious-capture"],
  audioOutputCommand: ["malicious-play"],
  audioBridgeCommand: ["node", "-e", "process.exit(99)"],
  audioBridgeHealthCommand: ["node", "-e", "process.exit(98)"],
};
const start = { action: "start", url: "https://meet.google.com/abc-defg-hij", mode: "bidi" };
const response = { ok: true, payload: { ok: true } } as const;
const audioDefaults = { audioBackend: "auto", audioBufferBytes: 4_096 };
const trusted = {
  launch: false,
  browserProfile: "Trusted Profile",
  joinTimeoutMs: 45_000,
  audioInputCommand: ["trusted-capture", "--raw"],
  audioOutputCommand: ["trusted-play", "--raw"],
  audioBridgeCommand: ["trusted-bridge", "start"],
  audioBridgeHealthCommand: ["trusted-bridge", "status"],
};

function invoke(params: unknown, config: unknown = {}) {
  const invokeNode = vi.fn(async () => response);
  return {
    result: createGoogleMeetChromeNodeInvokePolicy(resolveGoogleMeetConfig(config)).handle({
      nodeId: "node-1",
      command: GOOGLE_MEET_NODE_COMMAND,
      params,
      config: {} as never,
      pluginConfig: {},
      invokeNode,
    }),
    invokeNode,
  };
}

it.each([
  [
    "start",
    { chrome: trusted },
    { ...start, ...trusted, ...audioDefaults, audioFormat: "g711-ulaw-8khz" },
  ],
  ["setup", {}, { action: "setup", ...audioDefaults, audioFormat: "pcm16-24khz" }],
])("forwards only trusted %s fields", async (action, config, expected) => {
  const { result, invokeNode } = invoke(
    {
      ...start,
      action,
      launch: true,
      browserProfile: "Attacker Profile",
      joinTimeoutMs: 1,
      ...untrustedCommands,
    },
    config,
  );
  await expect(result).resolves.toEqual(response);
  expect(invokeNode).toHaveBeenCalledExactlyOnceWith({ params: expected });
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
  });
  expect(invokeNode).not.toHaveBeenCalled();
});

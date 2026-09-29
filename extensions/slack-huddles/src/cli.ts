import type { Command } from "commander";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import { MeetingPlatformAdapter } from "openclaw/plugin-sdk/meeting-runtime";
import { addTimerTimeoutGraceMs } from "openclaw/plugin-sdk/number-runtime";
import { slackHuddlesConfig, type SlackHuddlesConfig } from "./config.js";
import { slackHuddlesInvalidRequest } from "./errors.js";

export function resolveSlackHuddlesCliGatewayTimeoutMs(
  config: SlackHuddlesConfig,
  options: { probe: boolean; requestedTimeoutMs?: number },
): number {
  const operationTimeoutMs = slackHuddlesConfig.resolveGatewayOperationTimeoutMs(config);
  const probeTimeoutMs = options.probe
    ? MeetingPlatformAdapter.resolveProbeTimeoutMs(
        options.requestedTimeoutMs,
        config.chrome.joinTimeoutMs,
        slackHuddlesInvalidRequest,
      )
    : undefined;
  return probeTimeoutMs === undefined
    ? operationTimeoutMs
    : (addTimerTimeoutGraceMs(operationTimeoutMs, probeTimeoutMs) ?? 1);
}

export function registerSlackHuddlesCli(params: {
  program: Command;
  config: SlackHuddlesConfig;
}): void {
  MeetingPlatformAdapter.registerPluginCli({
    ...params,
    callGateway: callGatewayFromCli,
    commandName: "slackhuddles",
    methodPrefix: "slackhuddles",
    descriptions: {
      root: "Join and manage Slack huddle participants",
      join: "join a Slack huddle as the claw’s Slack user",
      leave: "leave a Slack huddle",
      status: "show Slack huddle session status",
      setup: "check Slack huddle prerequisites",
      testSpeech: "join and verify talk-back output",
      testListen: "join in transcribe mode and report caption support",
    },
    resolveGatewayTimeoutMs: ({ config, method, requestedTimeoutMs }) =>
      resolveSlackHuddlesCliGatewayTimeoutMs(config, {
        probe: method === "slackhuddles.testSpeech" || method === "slackhuddles.testListen",
        requestedTimeoutMs,
      }),
  });
}

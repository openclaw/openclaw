// Discord tests cover native command agent reply plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { DispatchReplyWithDispatcher } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchDiscordNativeAgentReply } from "./native-command-agent-reply.js";
import { buildDiscordNativeCommandContext } from "./native-command-context.js";
import { __testing as nativeCommandRuntimeTesting } from "./native-command.runtime.js";

const restoreRuntime: Array<() => void> = [];

afterEach(() => {
  while (restoreRuntime.length > 0) {
    restoreRuntime.pop()?.();
  }
});

function stubDispatchReplyWithDispatcher() {
  let captured: Parameters<DispatchReplyWithDispatcher>[0] | undefined;
  const previous = nativeCommandRuntimeTesting.setDispatchReplyWithDispatcher(async (params) => {
    captured = params;
    return { queuedFinal: false, counts: { final: 0, tool: 0, block: 0 } };
  });
  restoreRuntime.push(() => {
    nativeCommandRuntimeTesting.setDispatchReplyWithDispatcher(previous);
  });

  return () => {
    if (!captured) {
      throw new Error("native command dispatch was not captured");
    }
    return captured;
  };
}

function createCtxPayload() {
  return buildDiscordNativeCommandContext({
    prompt: "/ask hello",
    commandArgs: {},
    sessionKey: "agent:main:discord:slash:user-1",
    commandTargetSessionKey: "agent:main:discord:direct:user-1",
    accountId: "default",
    interactionId: "interaction-1",
    channelId: "dm-1",
    commandAuthorized: true,
    isDirectMessage: true,
    isGroupDm: false,
    isGuild: false,
    isThreadChannel: false,
    user: {
      id: "user-1",
      username: "tester",
      globalName: "Tester",
    },
    sender: {
      id: "user-1",
      tag: "tester#0001",
    },
    timestampMs: 123,
  });
}

async function captureNativeReplyOptions(params: {
  cfg: OpenClawConfig;
  discordConfig: NonNullable<OpenClawConfig["channels"]>["discord"];
}) {
  const capturedDispatch = stubDispatchReplyWithDispatcher();
  await dispatchDiscordNativeAgentReply({
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: "default",
    interaction: { reply: vi.fn(), followUp: vi.fn() } as never,
    ctxPayload: createCtxPayload(),
    effectiveRoute: { accountId: "default", agentId: "main" },
    channelConfig: null,
    mediaLocalRoots: [] as never,
    preferFollowUp: false,
    log: { error: vi.fn() } as never,
  });
  return capturedDispatch().replyOptions;
}

describe("dispatchDiscordNativeAgentReply", () => {
  it("suppresses inherited block streaming when Discord preview mode is live", async () => {
    const replyOptions = await captureNativeReplyOptions({
      cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
      discordConfig: { streaming: { mode: "partial" } },
    });

    expect(replyOptions?.disableBlockStreaming).toBe(true);
  });

  it("keeps explicit Discord block streaming ahead of preview mode", async () => {
    const replyOptions = await captureNativeReplyOptions({
      cfg: { agents: { defaults: { blockStreamingDefault: "on" } } },
      discordConfig: { streaming: { mode: "partial", block: { enabled: true } } },
    });

    expect(replyOptions?.disableBlockStreaming).toBe(false);
  });
});

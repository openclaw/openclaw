import {
  createChannelAdmissionAudit,
  createHostChannelIngressRuntime,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it, vi } from "vitest";
import * as imessageRuntime from "../runtime.js";
import { createIMessageGroupActivationResolver } from "./group-activation.js";
import { resolveIMessageInboundDecision } from "./inbound-processing.js";

const SENDER = "+15550001111";
const GROUP_ID = 99;

function createConfig(requireMention: boolean): OpenClawConfig {
  return {
    channels: {
      imessage: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        groups: { [String(GROUP_ID)]: { requireMention } },
      },
    },
    commands: { ownerAllowFrom: [`imessage:${SENDER}`] },
    messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
  } as OpenClawConfig;
}

async function resolve(params: {
  cfg: OpenClawConfig;
  text: string;
  activation: boolean | "read_failed" | undefined;
  botOwnedThread?: boolean;
}) {
  type GatewayContext = NonNullable<
    ReturnType<
      NonNullable<Parameters<typeof createHostChannelIngressRuntime>[0]["resolveGatewayContext"]>
    >
  >;
  const gateway = {
    getRuntimeConfig: () => params.cfg,
    channelAdmissionAudit: createChannelAdmissionAudit({ enabled: true }),
  } as GatewayContext;
  const runtime = createPluginRuntimeMock();
  runtime.channel.inbound.ingress = createHostChannelIngressRuntime({
    channelId: "imessage",
    isLive: () => true,
    resolveGatewayContext: () => gateway,
  });
  runtime.agent.session.getSessionEntryAsync = vi.fn(async () => {
    if (params.activation === "read_failed") {
      throw new Error("session worker unavailable");
    }
    return params.activation === undefined
      ? undefined
      : {
          sessionId: "imessage-activation-test",
          updatedAt: Date.now(),
          groupActivation: params.activation ? ("mention" as const) : ("always" as const),
        };
  });
  const runtimeSpy = vi.spyOn(imessageRuntime, "getIMessageRuntime").mockReturnValue(runtime);
  try {
    return await resolveIMessageInboundDecision({
      cfg: params.cfg,
      accountId: "default",
      message: {
        id: 1,
        chat_id: GROUP_ID,
        sender: SENDER,
        is_from_me: false,
        text: params.text,
        is_group: true,
        thread_originator_guid: params.botOwnedThread ? "bot-message" : undefined,
      },
      opts: {},
      messageText: params.text,
      bodyText: params.text,
      allowFrom: ["*"],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      isKnownFromMeMessageId: async () => params.botOwnedThread === true,
    });
  } finally {
    runtimeSpy.mockRestore();
  }
}

describe("iMessage session activation gating", () => {
  it("loads persisted group activation from the routed session", async () => {
    const cfg = createConfig(false);
    const sessionKey = "agent:main:imessage:group:99";
    const runtime = createPluginRuntimeMock();
    const getSessionEntryAsync = vi.fn().mockResolvedValue({
      sessionId: "imessage-activation-test",
      updatedAt: Date.now(),
      groupActivation: "mention",
    });
    runtime.agent.session.resolveStorePath = vi.fn(
      () => "/tmp/openclaw-imessage-activation-test.sqlite",
    );
    runtime.agent.session.getSessionEntryAsync = getSessionEntryAsync;
    const runtimeSpy = vi.spyOn(imessageRuntime, "getIMessageRuntime").mockReturnValue(runtime);
    try {
      await expect(
        createIMessageGroupActivationResolver(vi.fn())({ agentId: "main", sessionKey, cfg }),
      ).resolves.toBe(true);
      expect(getSessionEntryAsync).toHaveBeenCalledWith({
        agentId: "main",
        storePath: "/tmp/openclaw-imessage-activation-test.sqlite",
        sessionKey,
      });
    } finally {
      runtimeSpy.mockRestore();
    }
  });

  it("lets session mention activation override always-on group config", async () => {
    const cfg = createConfig(false);
    await expect(resolve({ cfg, text: "hello group", activation: true })).resolves.toEqual({
      kind: "drop",
      reason: "no mention",
    });
  });

  it("fails closed for ordinary messages when the activation read fails", async () => {
    await expect(
      resolve({
        cfg: createConfig(false),
        text: "hello group",
        activation: "read_failed",
      }),
    ).resolves.toEqual({ kind: "drop", reason: "no mention" });
  });

  it("still admits authorized recovery commands when the activation read fails", async () => {
    const decision = await resolve({
      cfg: createConfig(false),
      text: "/activation always",
      activation: "read_failed",
    });
    expect(decision.kind).toBe("dispatch");
  });

  it("lets session always activation override mention-only group config", async () => {
    const decision = await resolve({
      cfg: createConfig(true),
      text: "hello group",
      activation: false,
    });
    expect(decision.kind).toBe("dispatch");
  });

  it("preserves explicit bot-thread mention policy over session always activation", async () => {
    const cfg = createConfig(false);
    cfg.channels!.imessage!.groups![String(GROUP_ID)]!.requireMentionInBotThreads = true;
    await expect(
      resolve({ cfg, text: "hello thread", activation: false, botOwnedThread: true }),
    ).resolves.toEqual({ kind: "drop", reason: "no mention" });
  });

  it("still admits authorized activation commands in mention mode", async () => {
    const decision = await resolve({
      cfg: createConfig(true),
      text: "/activation always",
      activation: true,
    });
    expect(decision.kind).toBe("dispatch");
    if (decision.kind === "dispatch") {
      expect(decision.commandAuthorized).toBe(true);
      expect(decision.hasControlCommand).toBe(true);
    }
  });
});

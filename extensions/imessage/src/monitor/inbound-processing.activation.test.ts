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
  resolveGroupActivation: (params: {
    agentId: string;
    sessionKey: string;
    cfg: OpenClawConfig;
  }) => Promise<boolean | undefined>;
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
  const owner = {
    channelId: "imessage",
    isLive: () => true,
    resolveGatewayContext: () => gateway,
  };
  const runtime = createPluginRuntimeMock();
  runtime.channel.inbound.ingress = createHostChannelIngressRuntime(owner);
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
      },
      resolveGroupActivation: params.resolveGroupActivation,
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
    const getSessionEntryInWorker = vi.fn().mockResolvedValue({ groupActivation: "mention" });
    runtime.agent.session.resolveStorePath = vi.fn(
      () => "/tmp/openclaw-imessage-activation-test.sqlite",
    );
    runtime.agent.session.getSessionEntryInWorker = getSessionEntryInWorker;
    const runtimeSpy = vi.spyOn(imessageRuntime, "getIMessageRuntime").mockReturnValue(runtime);
    const resolveGroupActivation = createIMessageGroupActivationResolver(vi.fn());

    try {
      await expect(resolveGroupActivation({ agentId: "main", sessionKey, cfg })).resolves.toBe(
        true,
      );
      expect(getSessionEntryInWorker).toHaveBeenCalledWith({
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
    const resolveGroupActivation = vi.fn(async () => true);

    const decision = await resolve({ cfg, text: "hello group", resolveGroupActivation });

    expect(decision).toEqual({ kind: "drop", reason: "no mention" });
    expect(resolveGroupActivation).toHaveBeenCalledWith({
      agentId: "main",
      sessionKey: "agent:main:imessage:group:99",
      cfg,
    });
  });

  it("lets session always activation override mention-only group config", async () => {
    const decision = await resolve({
      cfg: createConfig(true),
      text: "hello group",
      resolveGroupActivation: async () => false,
    });

    expect(decision.kind).toBe("dispatch");
  });

  it("still admits authorized activation commands in mention mode", async () => {
    const decision = await resolve({
      cfg: createConfig(true),
      text: "/activation always",
      resolveGroupActivation: async () => true,
    });

    expect(decision.kind).toBe("dispatch");
    if (decision.kind !== "dispatch") {
      return;
    }
    expect(decision.commandAuthorized).toBe(true);
    expect(decision.hasControlCommand).toBe(true);
  });
});

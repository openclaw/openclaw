// Slack tests cover channel plugin behavior.
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import * as probeModule from "./probe.js";
import { SLACK_QUESTION_FINALIZATION_BLOCKS } from "./reply-action-ids.js";
import { setSlackRuntime } from "./runtime.js";

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

const { handleSlackActionMock } = vi.hoisted(() => ({ handleSlackActionMock: vi.fn() }));
const { resolveSlackDmChannelIdMock, sendMessageSlackMock } = vi.hoisted(() => ({
  resolveSlackDmChannelIdMock: vi.fn(),
  sendMessageSlackMock: vi.fn(),
}));
const {
  sessionApiCallMock,
  conversationsInfoMock,
  conversationsOpenMock,
  usersInfoMock,
  authTeamsListMock,
  getSlackWriteClientMock,
} = vi.hoisted(() => ({
  sessionApiCallMock: vi.fn(),
  conversationsInfoMock: vi.fn(),
  conversationsOpenMock: vi.fn(),
  usersInfoMock: vi.fn(),
  authTeamsListMock: vi.fn(),
  getSlackWriteClientMock: vi.fn(),
}));

vi.mock("./action-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./action-runtime.js")>("./action-runtime.js");
  return { ...actual, handleSlackAction: handleSlackActionMock };
});

vi.mock("./send.js", () => ({
  resolveSlackDmChannelId: resolveSlackDmChannelIdMock,
  sendMessageSlack: sendMessageSlackMock,
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  const createClient = () => ({
    apiCall: sessionApiCallMock,
    conversations: { info: conversationsInfoMock, open: conversationsOpenMock },
    users: { info: usersInfoMock },
    auth: { teams: { list: authTeamsListMock } },
  });
  return {
    ...actual,
    createSlackReadClient: vi.fn(createClient),
    createSlackLookupClient: vi.fn(createClient),
    getSlackWriteClient: getSlackWriteClientMock.mockImplementation(createClient),
  };
});

beforeEach(async () => {
  handleSlackActionMock.mockReset();
  resolveSlackDmChannelIdMock.mockReset();
  resolveSlackDmChannelIdMock.mockResolvedValue("D123");
  sendMessageSlackMock.mockReset();
  sendMessageSlackMock.mockResolvedValue({ messageId: "msg-1", channelId: "D123" });
  sessionApiCallMock.mockReset();
  sessionApiCallMock.mockResolvedValue({ ok: true });
  conversationsInfoMock.mockReset();
  conversationsOpenMock.mockReset();
  usersInfoMock.mockReset();
  authTeamsListMock.mockReset();
  getSlackWriteClientMock.mockClear();
  setSlackRuntime({
    channel: {
      slack: { handleSlackAction: handleSlackActionMock },
    },
  } as never);
});

async function getSlackConfiguredState(cfg: OpenClawConfig) {
  const account = slackPlugin.config.resolveAccount(cfg, "default");
  const inspectedAccount = slackPlugin.config.inspectAccount?.(cfg, "default") ?? account;
  return {
    configured: slackPlugin.config.isConfigured?.(account, cfg),
    snapshot: await slackPlugin.status?.buildAccountSnapshot?.({
      account: inspectedAccount as never,
      cfg,
      runtime: undefined,
    }),
  };
}

const requireRecord = createRequireRecord("record", "expected-label-object");

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`expected ${label} to be an array`);
  }
  return value;
}

function expectRecordFields(value: unknown, label: string, expected: Record<string, unknown>) {
  const record = requireRecord(value, label);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key]).toEqual(expectedValue);
  }
}

function requireMockCallArgValue(
  mock: ReturnType<typeof vi.fn>,
  callIndex: number,
  argIndex: number,
): unknown {
  return mock.mock.calls[callIndex]?.[argIndex];
}

function requireMockCallArg(mock: ReturnType<typeof vi.fn>, callIndex: number, argIndex: number) {
  return requireRecord(requireMockCallArgValue(mock, callIndex, argIndex), "mock call argument");
}

describe("slackPlugin actions", () => {
  it("keeps a bare current Grid send on the workspace-aware Slack action path", async () => {
    const prepareSendPayload = slackPlugin.actions!.prepareSendPayload!;
    const payload = { text: "hello" };

    const prepared = await prepareSendPayload({
      ctx: {
        action: "send",
        channel: "slack",
        cfg: {},
        params: {},
        toolContext: {
          currentChannelId: "team:T123:channel:C123",
          currentChannelProvider: "slack",
        },
      },
      to: "channel:C123",
      payload,
    } as never);

    expect(prepared).toBeNull();
  });

  it("keeps qualified and cross-channel sends on the core Slack delivery path", async () => {
    const prepareSendPayload = slackPlugin.actions!.prepareSendPayload!;
    const payload = { text: "hello" };
    const ctx = {
      action: "send",
      channel: "slack",
      cfg: {},
      params: {},
      toolContext: { currentChannelId: "team:T123:channel:C123" },
    };

    expect(prepareSendPayload({ ctx, to: "team:T123:channel:C123", payload } as never)).toBe(
      payload,
    );
    expect(prepareSendPayload({ ctx, to: "channel:C999", payload } as never)).toBe(payload);
  });

  it("uses configured defaultAccount for pairing approval notifications", async () => {
    const cfg = slackConfig({
      defaultAccount: "work",
      accounts: {
        work: { botToken: "xoxb-work" },
      },
    });
    const notify = slackPlugin.pairing!.notifyApproval!;

    await notify({ cfg, id: "U12345678" });

    expect(requireMockCallArgValue(sendMessageSlackMock, 0, 0)).toBe("user:U12345678");
    expect(String(requireMockCallArgValue(sendMessageSlackMock, 0, 1))).toContain("approved");
    expectRecordFields(requireMockCallArg(sendMessageSlackMock, 0, 2), "send options", {
      accountId: "work",
      cfg,
      token: "xoxb-work",
    });
  });

  it("workspace-qualifies Enterprise pairing approvals and notifications", async () => {
    const pairing = slackPlugin.pairing!;
    expect(
      pairing.resolveApprovalStoreEntry!({
        id: "team:T12345678:user:U12345678",
        meta: { senderId: "U12345678", teamId: "T12345678" },
      }),
    ).toBe("team:T12345678:user:U12345678");

    const cfg = slackConfig({
      accounts: {
        org: { botToken: "xoxb-org" },
      },
    });
    await pairing.notifyApproval!({
      cfg,
      id: "team:T12345678:user:U12345678",
      accountId: "org",
      meta: { senderId: "U12345678", teamId: "T12345678" },
    });

    expect(requireMockCallArgValue(sendMessageSlackMock, 0, 0)).toBe(
      "team:T12345678:user:U12345678",
    );
    expectRecordFields(requireMockCallArg(sendMessageSlackMock, 0, 2), "send options", {
      accountId: "org",
      cfg,
      token: "xoxb-org",
    });
  });

  it("treats interactive reply payloads as structured Slack payloads", () => {
    const hasStructuredReplyPayload = slackPlugin.messaging!.hasStructuredReplyPayload!;

    expect(
      hasStructuredReplyPayload({
        payload: {
          text: "Choose",
          interactive: {
            blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
          },
        },
      }),
    ).toBe(true);
  });

  it("forwards read threadId to Slack action handler", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ messages: [], hasMore: false });
    const handleAction = slackPlugin.actions!.handleAction!;

    await handleAction({
      action: "read",
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: {
        channelId: "C123",
        threadId: "1712345678.123456",
        messageId: "1712345678.654321",
      },
    });

    expectRecordFields(requireMockCallArg(handleSlackActionMock, 0, 0), "Slack action", {
      action: "readMessages",
      channelId: "C123",
      threadId: "1712345678.123456",
      messageId: "1712345678.654321",
    });
    expect(requireMockCallArgValue(handleSlackActionMock, 0, 1)).toEqual({});
    expect(requireMockCallArgValue(handleSlackActionMock, 0, 2)).toBeUndefined();
  });

  it.each([
    {
      action: "send",
      params: { to: "channel:C123", message: "render", media: "renders/file.wav" },
      runtimeAction: "sendMessage",
    },
  ] as const)("keeps host-owned media access authoritative for $action", async (testCase) => {
    handleSlackActionMock.mockResolvedValueOnce({ ok: true });
    const handleAction = slackPlugin.actions!.handleAction!;
    const mediaReadFile = vi.fn(async () => Buffer.from("trusted"));
    const mediaAccess = {
      localRoots: ["/tmp/workspace-agent"],
      readFile: mediaReadFile,
      workspaceDir: "/tmp/workspace-agent",
    };
    const forgedReadFile = vi.fn(async () => Buffer.from("forged"));

    await handleAction({
      action: testCase.action,
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: testCase.params,
      mediaAccess,
      mediaLocalRoots: mediaAccess.localRoots,
      conversationReadOrigin: "delegated",
      requesterAccountId: "default",
      requesterSenderId: "U123",
      toolContext: {
        currentChannelId: "C123",
        mediaAccess: { localRoots: ["/tmp/forged"], readFile: forgedReadFile },
        mediaLocalRoots: ["/tmp/forged"],
        mediaReadFile: forgedReadFile,
        conversationReadOrigin: "direct-operator",
        requesterAccountId: "forged",
        requesterSenderId: "forged",
      },
    } as never);

    expect(requireMockCallArg(handleSlackActionMock, 0, 0).action).toBe(testCase.runtimeAction);
    const actionContext = requireMockCallArg(handleSlackActionMock, 0, 2);
    expect(actionContext.mediaAccess).toBe(mediaAccess);
    expect(actionContext.mediaLocalRoots).toEqual(mediaAccess.localRoots);
    expect(actionContext.mediaReadFile).toBeUndefined();
    expect(actionContext.conversationReadOrigin).toBe("delegated");
    expect(actionContext.requesterAccountId).toBe("default");
    expect(actionContext.requesterSenderId).toBe("U123");
    expect(actionContext.currentChannelId).toBe("C123");
  });

  it("forwards the host media reader through bundled Slack uploads", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ ok: true });
    const mediaLocalRoots = ["/tmp/workspace-agent"];
    const mediaReadFile = vi.fn(async () => Buffer.from("file"));

    await slackPlugin.actions!.handleAction!({
      action: "upload-file",
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: {
        to: "channel:C123",
        filePath: "/tmp/workspace-agent/renders/file.wav",
        initialComment: "render",
      },
      mediaLocalRoots,
      mediaReadFile,
      toolContext: { currentChannelId: "C123", replyToMode: "all" },
    });

    expect(requireMockCallArg(handleSlackActionMock, 0, 0)).toMatchObject({
      action: "uploadFile",
      filePath: "/tmp/workspace-agent/renders/file.wav",
      initialComment: "render",
    });
    expect(requireMockCallArg(handleSlackActionMock, 0, 2)).toMatchObject({
      currentChannelId: "C123",
      replyToMode: "all",
      mediaLocalRoots,
      mediaReadFile,
    });
  });

  it("does not inherit forged media capabilities from generic Slack tool context", async () => {
    handleSlackActionMock.mockResolvedValueOnce({ ok: true });
    const handleAction = slackPlugin.actions!.handleAction!;
    const forgedReadFile = vi.fn(async () => Buffer.from("forged"));

    await handleAction({
      action: "upload-file",
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: { to: "channel:C123", filePath: "renders/file.wav" },
      toolContext: {
        currentChannelId: "C123",
        mediaAccess: { localRoots: ["/tmp/forged"], readFile: forgedReadFile },
        mediaLocalRoots: ["/tmp/forged"],
        mediaReadFile: forgedReadFile,
        conversationReadOrigin: "direct-operator",
        requesterAccountId: "forged",
        requesterSenderId: "forged",
      },
    } as never);

    const actionContext = requireMockCallArg(handleSlackActionMock, 0, 2);
    expect(actionContext.mediaAccess).toBeUndefined();
    expect(actionContext.mediaLocalRoots).toBeUndefined();
    expect(actionContext.mediaReadFile).toBeUndefined();
    expect(actionContext.conversationReadOrigin).toBeUndefined();
    expect(actionContext.requesterAccountId).toBeUndefined();
    expect(actionContext.requesterSenderId).toBeUndefined();
    expect(actionContext.currentChannelId).toBe("C123");
  });
});

describe("slackPlugin status", () => {
  it.each(["user", "bot"] as const)(
    "probes the %s identity without an initialized runtime",
    async (identity) => {
      setSlackRuntime(null as never);
      const probe = {
        ok: true,
        status: 200,
        [identity]: { id: "U12345678", name: "test-identity" },
      };
      const probeSpy = vi.spyOn(probeModule, "probeSlack").mockResolvedValueOnce(probe);
      const cfg = slackConfig({
        accounts: {
          work: {
            postAs: identity,
            botToken: "xoxb-work",
            userToken: "test-user-token",
            appToken: "xapp-work",
          },
        },
      });
      const account = slackPlugin.config.resolveAccount(cfg, "work");
      expect(await slackPlugin.status!.probeAccount!({ account, timeoutMs: 2500, cfg })).toEqual(
        probe,
      );
      expect(probeSpy).toHaveBeenCalledWith(
        identity === "user" ? "test-user-token" : "xoxb-work",
        2500,
        {
          accountId: "work",
          ...(identity === "user" ? { identity } : {}),
        },
      );
    },
  );

  it("renders Slack probe token warnings in capabilities output", () => {
    const lines = slackPlugin.status?.formatCapabilitiesProbe?.({
      probe: {
        ok: true,
        warning: "Slack bot token is a user token",
        bot: { id: "UUSER", name: "human-installer" },
        team: { id: "T1", name: "OpenClaw" },
      },
    });

    expect(lines).toStrictEqual([
      { text: "Warning: Slack bot token is a user token", tone: "warn" },
      { text: "Bot: @human-installer" },
      { text: "Team: OpenClaw (T1)" },
    ]);
  });

  it("renders the resolved human identity in capabilities output", () => {
    const lines = slackPlugin.status?.formatCapabilitiesProbe?.({
      probe: {
        ok: true,
        user: { id: "U12345678", name: "test-human" },
        team: { id: "T12345678", name: "Test Team" },
      },
    });

    expect(lines).toStrictEqual([
      { text: "User identity: @test-human (U12345678)" },
      { text: "Team: Test Team (T12345678)" },
    ]);
  });

  it("matches the workspace-qualified session identity produced by Enterprise ingress", async () => {
    const resolveRoute = slackPlugin.messaging!.resolveOutboundSessionRoute!;

    const channelRoute = await resolveRoute({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      target: "team:T123:channel:C456",
      currentSessionKey: "agent:main:slack:channel:team:t123:channel:c456:thread:1712345678.123456",
    });
    const dmRoute = await resolveRoute({
      cfg: {} as OpenClawConfig,
      agentId: "main",
      accountId: "default",
      target: "team:T123:user:U456",
    });

    expectRecordFields(channelRoute, "Enterprise Slack channel route", {
      baseSessionKey: "agent:main:slack:channel:team:t123:channel:c456",
      sessionKey: "agent:main:slack:channel:team:t123:channel:c456:thread:1712345678.123456",
      threadId: "1712345678.123456",
      to: "team:T123:channel:C456",
    });
    expectRecordFields(dmRoute, "Enterprise Slack DM route", {
      baseSessionKey: "agent:main:main:account:default:team:t123",
      to: "team:T123:user:U456",
    });
  });

  it.each(["heartbeat-owner", undefined] as const)(
    "limits Enterprise workspace discovery to owner heartbeats: %s",
    async (deliveryPurpose) => {
      const installation = registerSlackInstallationState("default", "enterprise");
      usersInfoMock.mockResolvedValue({
        ok: true,
        user: { id: "U12345678", enterprise_user: { teams: ["T22222222", "T11111111"] } },
      });
      authTeamsListMock.mockResolvedValue({
        ok: true,
        teams: [{ id: "T22222222" }, { id: "T11111111" }],
      });
      try {
        const route = await slackPlugin.messaging!.resolveOutboundSessionRoute!({
          cfg: slackConfig({ botToken: "sending-fixture" }),
          agentId: "main",
          target: "user:u12345678",
          deliveryPurpose,
        });
        if (!deliveryPurpose) {
          expectRecordFields(route, "Detached Enterprise Slack DM route", { to: "user:u12345678" });
          expect(usersInfoMock).not.toHaveBeenCalled();
          expect(authTeamsListMock).not.toHaveBeenCalled();
          return;
        }
        expectRecordFields(route, "Enterprise Slack owner DM route", {
          baseSessionKey: "agent:main:main:account:default:team:t11111111",
          to: "team:T11111111:user:U12345678",
          recipientSessionExact: true,
        });
        expect(usersInfoMock).toHaveBeenCalledExactlyOnceWith({ user: "U12345678" });
        expect(conversationsOpenMock).not.toHaveBeenCalled();
      } finally {
        installation.release();
      }
    },
  );

  it.each([
    {
      target: "d0aewsdhaqh",
      channel: { id: "D0AEWSDHAQH", is_im: true, user: "U09G2DJ0275" },
      expected: {
        sessionKey: "agent:main:slack:direct:u09g2dj0275:thread:1778110574.653649",
        baseSessionKey: "agent:main:slack:direct:u09g2dj0275",
        chatType: "direct",
        from: "slack:U09G2DJ0275",
        to: "user:U09G2DJ0275",
        threadId: "1778110574.653649",
        recipientSessionExact: true,
        peer: { kind: "direct", id: "U09G2DJ0275" },
      },
    },
    { target: "D0NOUSER001", channel: { id: "D0NOUSER001", is_im: true }, expected: null },
    {
      target: "g08gqh53ejm",
      channel: { id: "G08GQH53EJM", is_mpim: true },
      expected: {
        sessionKey: "agent:main:slack:group:g08gqh53ejm:thread:1778110574.653649",
        chatType: "channel",
        from: "slack:group:g08gqh53ejm",
        to: "channel:g08gqh53ejm",
        recipientSessionExact: true,
        peer: { kind: "group", id: "g08gqh53ejm" },
      },
    },
  ])(
    "routes $target using read-only conversation metadata",
    async ({ target, channel, expected }) => {
      conversationsInfoMock.mockResolvedValueOnce({ channel });
      const route = await slackPlugin.messaging!.resolveOutboundSessionRoute!({
        cfg: {
          ...slackConfig({ botToken: "xoxb-test", appToken: "xapp-test" }),
          session: { dmScope: "per-channel-peer" },
        },
        agentId: "main",
        target,
        threadId: "1778110574.653649",
      });
      if (expected) {
        expect(route).toMatchObject(expected);
      } else {
        expect(route).toBeNull();
      }
      expect(conversationsInfoMock).toHaveBeenCalledWith({ channel: channel.id });
      expect(conversationsOpenMock).not.toHaveBeenCalled();
    },
  );
});

describe("slackPlugin messaging targets", () => {
  it("folds comparison, delivery, and session identities", () => {
    const messaging = slackPlugin.messaging!;
    expect(messaging.normalizeTarget!("channel:C08GQH53EJM")).toBe("channel:c08gqh53ejm");
    expect(messaging.resolveDeliveryTarget!({ conversationId: "G08GQH53EJM" })).toEqual({
      to: "channel:g08gqh53ejm",
    });
    expect(
      messaging.resolveDeliveryTarget!({
        conversationId: "1712345678.654321",
        parentConversationId: "user:U08GQH53EJM",
      }),
    ).toEqual({ to: "user:u08gqh53ejm", threadId: "1712345678.654321" });
    expect(messaging.resolveSessionTarget!({ kind: "channel", id: "C08GQH53EJM" })).toBe(
      "channel:c08gqh53ejm",
    );
  });
});

describe("slackPlugin security", () => {
  it("normalizes dm allowlist entries with trimmed prefixes", () => {
    const cfg = slackConfig({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      dmPolicy: "allowlist",
      allowFrom: ["  slack:U123  "],
    });
    const result = slackPlugin.security!.resolveDmPolicy!({
      cfg,
      account: slackPlugin.config.resolveAccount(cfg, "default"),
    })!;

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  slack:U123  "]);
    expect(result.policyPath).toBe("channels.slack.dmPolicy");
    expect(result.allowFromPath).toBe("channels.slack.");
    expect(result.normalizeEntry?.("  slack:U123  ")).toBe("U123");
    expect(result.normalizeEntry?.("  user:U999  ")).toBe("U999");
  });
});

describe("slackPlugin outbound", () => {
  const cfg = slackConfig({ botToken: "xoxb-test", appToken: "xapp-test" });

  it("rejects bare deferred Enterprise messages and admits workspace-qualified targets", () => {
    const admit = slackPlugin.message!.durableFinal!.admitDeferredDelivery!;
    const base = {
      cfg,
      accountId: "default",
      kind: "text" as const,
      queueId: "q1",
      payloads: [{ text: "hello" }],
    };

    const installationState = registerSlackInstallationState("default", "enterprise");
    try {
      expect(admit({ ...base, to: "channel:C456" } as never)).toEqual({
        status: "permanent_rejection",
        reason: expect.stringContaining("unsupported_enterprise_slack_delivery"),
      });
      expect(admit({ ...base, to: "team:T123:channel:C456" } as never)).toEqual({
        status: "allowed",
      });
    } finally {
      installationState.release();
    }
    const workspaceState = registerSlackInstallationState("default", "workspace");
    try {
      expect(admit({ ...base, to: "channel:C456" } as never)).toEqual({ status: "allowed" });
    } finally {
      workspaceState.release();
    }
    expect(admit({ ...base, to: "channel:C456" } as never)).toEqual({ status: "allowed" });
  });

  it("forwards agent identity through the registered text sender", async () => {
    const sendText = slackPlugin.outbound!.sendText!;

    await sendText({
      cfg,
      to: "C123",
      text: "heartbeat alert",
      accountId: "default",
      identity: { name: "Pulse", emoji: "📟" },
      deliveryQueueId: "queue-1",
    });

    expect(sendMessageSlackMock).toHaveBeenCalledWith(
      "C123",
      "heartbeat alert",
      expect.objectContaining({
        deliveryQueueId: "queue-1",
        identity: { username: "Pulse", iconUrl: undefined, iconEmoji: "📟" },
      }),
    );
  });

  it("forwards partial-send progress through the registered Slack sender", async () => {
    const sendSlack = vi.fn(async (...args: unknown[]) => {
      const options = args[2] as {
        onDeliveryResult?: (result: { messageId: string }) => Promise<void>;
      };
      await options.onDeliveryResult?.({ messageId: "m-first" });
      throw new Error("later Slack chunk failed");
    });
    const onDeliveryResult = vi.fn();
    const sendText = slackPlugin.outbound!.sendText!;

    await expect(
      sendText({
        cfg,
        to: "C123",
        text: "long message",
        accountId: "default",
        deps: { sendSlack },
        onDeliveryResult,
      }),
    ).rejects.toThrow("later Slack chunk failed");

    expect(onDeliveryResult).toHaveBeenCalledWith({ channel: "slack", messageId: "m-first" });
  });

  it("uses the workspace-partitioned write-client cache for Grid session status", async () => {
    const target = {
      cfg: slackConfig({ botToken: "xoxb-test" }),
      to: "team:T123:channel:C456",
      accountId: "default",
      threadId: "1712345678.123456",
    };

    await slackPlugin.heartbeat!.sendTyping!(target);
    await slackPlugin.heartbeat!.clearTyping!(target);

    expect(getSlackWriteClientMock).toHaveBeenNthCalledWith(1, "xoxb-test", { teamId: "T123" });
    expect(getSlackWriteClientMock).toHaveBeenNthCalledWith(2, "xoxb-test", { teamId: "T123" });
    expect(resolveSlackDmChannelIdMock).not.toHaveBeenCalled();
    expect(sessionApiCallMock.mock.calls).toEqual(
      ["processing", "active"].map((status) => [
        "agents.sessions.setStatus",
        { token: "xoxb-test", channel_id: "C456", thread_ts: "1712345678.123456", status },
      ]),
    );
  });

  it("resolves user targets to concrete DM channels for session status", async () => {
    await slackPlugin.heartbeat!.sendTyping!({
      cfg,
      to: "user:u09g2dj0275",
      accountId: "default",
      threadId: "1712345678.123456",
    });

    expect(resolveSlackDmChannelIdMock).toHaveBeenCalledWith({
      client: expect.any(Object),
      userId: "U09G2DJ0275",
      accountId: "default",
      token: "xoxb-test",
    });
    expect(sessionApiCallMock).toHaveBeenCalledWith("agents.sessions.setStatus", {
      token: "xoxb-test",
      channel_id: "D123",
      thread_ts: "1712345678.123456",
      status: "processing",
    });
  });

  it("auto-threads a DM target after target resolution strips its user prefix", async () => {
    const resolveTarget = slackPlugin.messaging!.targetResolver!.resolveTarget!;
    const resolveAutoThreadId = slackPlugin.threading!.resolveAutoThreadId!;

    const resolved = await resolveTarget({
      cfg,
      accountId: "default",
      input: "user:U123",
      normalized: "user:u123",
    });

    expect(resolved).toMatchObject({ to: "U123", kind: "user" });
    expect(
      resolveAutoThreadId({
        cfg,
        to: resolved?.to ?? "",
        toolContext: {
          currentChannelId: "D123",
          currentMessagingTarget: "user:U123",
          currentThreadTs: "1712345678.123456",
          replyToMode: "all",
        },
      }),
    ).toBe("1712345678.123456");
  });

  it("does not recover invalid Slack auto-thread anchors", () => {
    const resolveAutoThreadId = slackPlugin.threading!.resolveAutoThreadId!;

    const threadId = resolveAutoThreadId({
      cfg,
      to: "channel:C123",
      replyToId: "msg-internal-1",
      toolContext: {
        currentChannelId: "C123",
        currentThreadTs: "thread-root",
        replyToMode: "all",
      },
    });

    expect(threadId).toBeUndefined();
  });

  it("does not stringify numeric thread ids in tool context", () => {
    const buildToolContext = slackPlugin.threading!.buildToolContext!;

    const context = buildToolContext({
      cfg,
      context: { To: "channel:C123", MessageThreadId: 1712345678.123456 },
    });

    expect(context?.currentThreadTs).toBeUndefined();
  });

  it("falls back to threadId in reply transport when replyToId is not a Slack thread timestamp", () => {
    const resolveReplyTransport = slackPlugin.threading!.resolveReplyTransport!;

    expect(
      resolveReplyTransport({ cfg, replyToId: "msg-internal-1", threadId: "1712345678.123456" }),
    ).toEqual({ replyToId: "1712345678.123456", threadId: null });
    expect(
      resolveReplyTransport({
        cfg,
        replyToId: "9999999999.999999",
        replyDelivery: { chatType: "channel", replyToMode: "off" },
      }),
    ).toEqual({ replyToId: null, threadId: null });
  });

  it.each([
    {
      name: "current",
      replyToIsExplicit: true,
      replyToCurrent: true,
      expectedReplyToId: "1712345678.123456",
    },
    {
      name: "inherited",
      replyToIsExplicit: false,
      expectedReplyToId: "1712345678.123456",
    },
    { name: "explicit", replyToIsExplicit: true, expectedReplyToId: "1712345688.654321" },
  ])(
    "routes $name child replies to $expectedReplyToId",
    ({ replyToIsExplicit, replyToCurrent, expectedReplyToId }) => {
      const resolveReplyTransport = slackPlugin.threading!.resolveReplyTransport!;

      expect(
        resolveReplyTransport({
          cfg,
          replyToId: "1712345688.654321",
          threadId: "1712345678.123456",
          replyToIsExplicit,
          replyToCurrent,
        }),
      ).toEqual({ replyToId: expectedReplyToId, threadId: null });
    },
  );

  it("ignores explicit reply targets for off-mode final delivery", () => {
    const resolveReplyTransport = slackPlugin.threading!.resolveReplyTransport!;

    expect(
      resolveReplyTransport({
        cfg,
        replyToId: "9999999999.999999",
        threadId: "1712345678.123456",
        replyDelivery: { chatType: "channel", replyToMode: "off" },
      }),
    ).toEqual({ replyToId: "1712345678.123456", threadId: null });
  });

  it("renders shared interactive payloads into Slack Block Kit via plugin outbound", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-interactive" });
    const sendPayload = slackPlugin.outbound!.sendPayload!;

    const result = await sendPayload({
      cfg,
      to: "user:U123",
      text: "",
      payload: {
        text: "Slack interactive smoke.",
        interactive: {
          blocks: [
            { type: "text", text: "Slack interactive smoke." },
            {
              type: "buttons",
              buttons: [
                { label: "Approve", value: "approve" },
                { label: "Reject", value: "reject" },
              ],
            },
            {
              type: "select",
              placeholder: "Choose a target",
              options: [
                { label: "Canary", value: "canary" },
                { label: "Production", value: "production" },
              ],
            },
          ],
        },
      },
      accountId: "default",
      deps: { sendSlack },
    });

    expect(requireMockCallArgValue(sendSlack, 0, 0)).toBe("user:U123");
    expect(requireMockCallArgValue(sendSlack, 0, 1)).toBe(
      "Slack interactive smoke.\n\nApprove\nReject\n\nChoose a target\nCanary\nProduction",
    );
    expect(requireMockCallArg(sendSlack, 0, 2).blocks).toMatchObject([
      { type: "section" },
      {
        type: "actions",
        elements: [
          { type: "button", value: "approve" },
          { type: "button", value: "reject" },
        ],
      },
      {
        type: "actions",
        elements: [
          { type: "static_select", options: [{ value: "canary" }, { value: "production" }] },
        ],
      },
    ]);
    expect(result).toEqual({ channel: "slack", messageId: "m-interactive" });
  });

  it.each([
    { surface: "interactive", type: "text" },
    { surface: "presentation", type: "context" },
  ] as const)(
    "delivers oversized $surface $type in order across the real Slack outbound adapter",
    async ({ surface, type }) => {
      const sendSlack = vi
        .fn()
        .mockResolvedValueOnce({ messageId: "m-chunk-1" })
        .mockResolvedValueOnce({ messageId: "m-chunk-2" });
      const text = "x".repeat(3_000 * 50 + 1);
      const buttons = {
        type: "buttons" as const,
        buttons: [{ label: "Continue", value: "continue" }],
      };
      const presentationTextBlock =
        type === "context" ? { type: "context" as const, text } : { type: "text" as const, text };
      const payload =
        surface === "interactive"
          ? { text: "", interactive: { blocks: [{ type: "text" as const, text }, buttons] } }
          : { text: "", presentation: { blocks: [presentationTextBlock, buttons] } };

      const result = await slackPlugin.outbound!.sendPayload!({
        cfg,
        to: "channel:C123",
        text: "",
        payload,
        accountId: "default",
        deps: { sendSlack },
      });
      const batches = sendSlack.mock.calls.map((_call, index) =>
        requireArray(requireMockCallArg(sendSlack, index, 2).blocks, "Slack blocks"),
      );
      const delivered = batches.flat().flatMap((entry) => {
        const block = requireRecord(entry, "Slack block");
        const textObject =
          block.type === "context"
            ? requireArray(block.elements, "context elements")[0]
            : block.type === "section"
              ? block.text
              : undefined;
        return textObject ? [String(requireRecord(textObject, "Slack text").text)] : [];
      });

      expect(batches.map((blocks) => blocks.length)).toEqual([50, 2]);
      expect(delivered.join("")).toBe(text);
      expect(batches[1]?.[1]).toMatchObject({ type: "actions" });
      expect(result).toMatchObject({
        channel: "slack",
        messageId: "m-chunk-2",
        receipt: { platformMessageIds: ["m-chunk-1", "m-chunk-2"] },
      });
    },
  );

  it("retains media and every reply receipt without losing an earlier question card", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const questionMeta = {
      slackQuestionActionIds: ["openclaw:question_button:1:1"],
      [SLACK_QUESTION_FINALIZATION_BLOCKS]: [{ type: "divider" as const }],
    };
    const createResult = (messageId: string, kind: "media" | "card") => ({
      messageId,
      channelId: "C123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "slack", messageId }],
        kind,
      }),
    });
    const sendSlack = vi
      .fn()
      .mockResolvedValueOnce(createResult("m-upload", "media"))
      .mockResolvedValueOnce({ ...createResult("m-question", "card"), meta: questionMeta })
      .mockResolvedValueOnce(createResult("m-final", "card"));

    const result = await slackPlugin.outbound!.sendPayload!({
      cfg,
      to: "channel:C123",
      text: "",
      accountId: "default",
      deps: { sendSlack },
      payload: {
        text: "",
        mediaUrls: ["https://example.com/context.png"],
        channelData: {
          askUser: { questionId, optionValues: ["one", "two"] },
          slack: { blocks: Array.from({ length: 48 }, () => ({ type: "divider" as const })) },
        },
        presentation: {
          blocks: [
            {
              type: "buttons",
              buttons: [
                {
                  label: "Answer",
                  action: { type: "question", questionId, optionValue: "one" },
                },
              ],
            },
            { type: "text", text: "x".repeat(3_001) },
          ],
        },
      },
    });

    expect(sendSlack).toHaveBeenCalledTimes(3);
    expect(result.messageId).toBe("m-final");
    expect(result.receipt?.platformMessageIds).toEqual(["m-upload", "m-question", "m-final"]);
    expect(result.receipt?.parts.map((part) => part.index)).toEqual([0, 1, 2]);
    expect(result.meta).toEqual({ ...questionMeta, slackQuestionMessageId: "m-question" });
  });
});

describe("Slack message presentation", () => {
  const cfg = slackConfig({ botToken: "xoxb-test", appToken: "xapp-test" });
  it("renders portable presentations through the facade as card receipts (#95440)", async () => {
    const sendSlack = vi.fn().mockResolvedValueOnce({
      messageId: "msg-1",
      channelId: "C123",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "slack", messageId: "msg-1", channelId: "C123" }],
        kind: "card",
      }),
    });
    const outbound = slackPlugin.outbound;
    const renderPresentation = outbound?.renderPresentation;
    if (!renderPresentation) {
      throw new Error("Expected Slack presentation renderer");
    }

    const presentation = {
      title: "Status",
      blocks: [{ type: "divider" as const }],
    };
    const payload = { text: "Fallback", presentation };
    const rendered = await renderPresentation({
      payload,
      presentation,
      ctx: { cfg, to: "C123", text: payload.text, payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack presentation payload");
    }
    // Core consumes the portable presentation before handing the native payload to the adapter.
    const { presentation: _presentation, ...deliveryPayload } = rendered;

    const result = await slackPlugin.message!.send!.payload!({
      cfg,
      to: "C123",
      text: deliveryPayload.text ?? "",
      payload: deliveryPayload,
      accountId: "default",
      deps: { sendSlack },
    });

    const to = requireMockCallArgValue(sendSlack, 0, 0);
    const text = requireMockCallArgValue(sendSlack, 0, 1);
    const options = requireMockCallArg(sendSlack, 0, 2);
    expect(to).toBe("C123");
    expect(text).toBe("Fallback\n\nStatus");
    expect(options.blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Fallback", verbatim: true },
      },
      {
        type: "header",
        text: { type: "plain_text", text: "Status", emoji: true },
      },
      { type: "divider" },
    ]);
    expect(result.receipt.parts[0]?.kind).toBe("card");
  });
});

describe("slackPlugin directory", () => {
  it("lists configured peers without throwing a ReferenceError", async () => {
    const listPeers = slackPlugin.directory!.listPeers!;

    await expect(
      listPeers({
        cfg: slackConfig({
          dms: {
            U123: {},
          },
        }),
        runtime: createRuntimeEnv(),
      }),
    ).resolves.toEqual([{ id: "user:u123", kind: "user" }]);
  });
});

describe("slackPlugin configured bindings", () => {
  it("matches Slack thread replies against configured channel bindings", () => {
    const bindings = slackPlugin.bindings!;
    const compiledBinding = bindings.compileConfiguredBinding({
      binding: {} as never,
      conversationId: "C123",
    });

    expect(compiledBinding).toEqual({ conversationId: "c123" });
    expect(
      bindings.matchInboundConversation({
        binding: {} as never,
        compiledBinding: compiledBinding!,
        conversationId: "1770408518.451689",
        parentConversationId: "C123",
      }),
    ).toEqual({ conversationId: "c123", matchPriority: 1 });
  });
});

describe("slackPlugin config", () => {
  it("requires an app token for Socket Mode bot accounts", async () => {
    const { configured, snapshot } = await getSlackConfiguredState(
      slackConfig({ mode: "socket", botToken: "xoxb-socket" }),
    );
    expect(configured).toBe(false);
    expect(snapshot?.configured).toBe(false);
  });

  it.each([
    {
      name: "Socket Mode",
      slack: {
        postAs: "user" as const,
        userToken: "test-user-token",
        appToken: "test-app-token",
      },
      expectedTransportSource: { appTokenSource: "config" },
    },
    {
      name: "HTTP mode",
      slack: {
        postAs: "user" as const,
        mode: "http" as const,
        userToken: "test-user-token",
        signingSecret: "test-signing-secret",
      },
      expectedTransportSource: { signingSecretSource: "config" },
    },
  ])(
    "treats a complete user-identity $name account as configured",
    async ({ slack, expectedTransportSource }) => {
      const { configured, snapshot } = await getSlackConfiguredState({
        channels: { slack },
      } as OpenClawConfig);

      expect(configured).toBe(true);
      expect(snapshot).toMatchObject({
        configured: true,
        identity: "user",
        userTokenSource: "config",
        userTokenStatus: "available",
        ...expectedTransportSource,
      });
    },
  );

  it("does not mark partial configured-unavailable token status as configured", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: false,
        botTokenStatus: "configured_unavailable",
        appTokenStatus: "missing",
        botTokenSource: "config",
        appTokenSource: "none",
        config: {},
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(false);
    expect(snapshot?.botTokenStatus).toBe("configured_unavailable");
    expect(snapshot?.appTokenStatus).toBe("missing");
  });

  it("keeps HTTP mode signing-secret unavailable accounts configured in snapshots", async () => {
    const snapshot = await slackPlugin.status?.buildAccountSnapshot?.({
      account: {
        accountId: "default",
        name: "Default",
        enabled: true,
        configured: true,
        mode: "http",
        botTokenStatus: "available",
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
        botTokenSource: "config",
        signingSecretSource: "config", // pragma: allowlist secret
        config: {
          mode: "http",
          botToken: "xoxb-http",
          signingSecret: { source: "env", provider: "default", id: "SLACK_SIGNING_SECRET" },
        },
      } as never,
      cfg: {} as OpenClawConfig,
      runtime: undefined,
    });

    expect(snapshot?.configured).toBe(true);
    expect(snapshot?.botTokenStatus).toBe("available");
    expect(snapshot?.signingSecretStatus).toBe("configured_unavailable");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

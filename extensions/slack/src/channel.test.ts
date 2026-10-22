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

const THREAD_TS = "1712345678.123456";
const messaging = slackPlugin.messaging!;
const threading = slackPlugin.threading!;
const outbound = slackPlugin.outbound!;

function route(
  params: Omit<
    Parameters<NonNullable<typeof messaging.resolveOutboundSessionRoute>>[0],
    "cfg" | "agentId"
  > & { cfg?: OpenClawConfig },
) {
  return messaging.resolveOutboundSessionRoute!({ cfg: {}, agentId: "main", ...params });
}

function slackConfig(slack: NonNullable<OpenClawConfig["channels"]>["slack"]): OpenClawConfig {
  return { channels: { slack } };
}

const mocks = vi.hoisted(() => ({
  handleAction: vi.fn(),
  resolveDm: vi.fn(),
  sendMessage: vi.fn(),
  sessionCall: vi.fn(),
  conversationInfo: vi.fn(),
  conversationOpen: vi.fn(),
  userInfo: vi.fn(),
  teamsList: vi.fn(),
  writeClient: vi.fn(),
}));

vi.mock("./action-runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./action-runtime.js")>("./action-runtime.js");
  return { ...actual, handleSlackAction: mocks.handleAction };
});

// mock-isolation: Channel routing captures outbound sends without contacting Slack.
vi.mock("./send.js", () => ({
  resolveSlackDmChannelId: mocks.resolveDm,
  sendMessageSlack: mocks.sendMessage,
}));

vi.mock("./client.js", async () => {
  const actual = await vi.importActual<typeof import("./client.js")>("./client.js");
  const createClient = () => ({
    apiCall: mocks.sessionCall,
    conversations: { info: mocks.conversationInfo, open: mocks.conversationOpen },
    users: { info: mocks.userInfo },
    auth: { teams: { list: mocks.teamsList } },
  });
  return {
    ...actual,
    createSlackReadClient: vi.fn(createClient),
    createSlackLookupClient: vi.fn(createClient),
    getSlackWriteClient: mocks.writeClient.mockImplementation(createClient),
  };
});

beforeEach(() => {
  for (const mock of [
    mocks.handleAction,
    mocks.resolveDm,
    mocks.sendMessage,
    mocks.sessionCall,
    mocks.conversationInfo,
    mocks.conversationOpen,
    mocks.userInfo,
    mocks.teamsList,
  ]) {
    mock.mockReset();
  }
  mocks.resolveDm.mockResolvedValue("D123");
  mocks.sendMessage.mockResolvedValue({ messageId: "msg-1", channelId: "D123" });
  mocks.sessionCall.mockResolvedValue({ ok: true });
  mocks.writeClient.mockClear();
  setSlackRuntime({ channel: { slack: { handleSlackAction: mocks.handleAction } } } as never);
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

function callArg(mock: ReturnType<typeof vi.fn>, argIndex = 0, callIndex = 0): unknown {
  return mock.mock.calls[callIndex]?.[argIndex];
}

function callRecord(mock: ReturnType<typeof vi.fn>, argIndex = 0, callIndex = 0) {
  return requireRecord(callArg(mock, argIndex, callIndex), "mock call argument");
}

describe("slackPlugin actions", () => {
  it.each([
    { to: "channel:C123", provider: "slack", workspaceAware: true },
    { to: "team:T123:channel:C123", provider: undefined, workspaceAware: false },
    { to: "channel:C999", provider: undefined, workspaceAware: false },
  ])("selects the workspace-aware send path for $to", ({ to, provider, workspaceAware }) => {
    const payload = { text: "hello" };
    const prepared = slackPlugin.actions!.prepareSendPayload!({
      ctx: {
        action: "send",
        channel: "slack",
        cfg: {},
        params: {},
        toolContext: {
          currentChannelId: "team:T123:channel:C123",
          currentChannelProvider: provider,
        },
      },
      to,
      payload,
    } as never);
    expect(prepared).toBe(workspaceAware ? null : payload);
  });

  it.each([
    { accountId: "work", id: "U12345678", token: "xoxb-work", qualified: false },
    { accountId: "org", id: "team:T12345678:user:U12345678", token: "xoxb-org", qualified: true },
  ])("routes pairing approval through $accountId", async ({ accountId, id, token, qualified }) => {
    const meta = qualified ? { senderId: "U12345678", teamId: "T12345678" } : undefined;
    const cfg = slackConfig({
      ...(qualified ? {} : { defaultAccount: accountId }),
      accounts: { [accountId]: { botToken: token } },
    });
    if (qualified) {
      expect(slackPlugin.pairing!.resolveApprovalStoreEntry!({ id, meta })).toBe(id);
    }
    await slackPlugin.pairing!.notifyApproval!({
      cfg,
      id,
      ...(qualified ? { accountId, meta } : {}),
    });
    expect(callArg(mocks.sendMessage)).toBe(qualified ? id : "user:U12345678");
    if (!qualified) {
      expect(String(callArg(mocks.sendMessage, 1))).toContain("approved");
    }
    expect(callRecord(mocks.sendMessage, 2)).toMatchObject({ accountId, cfg, token });
  });

  it("treats interactive reply payloads as structured Slack payloads", () => {
    expect(
      messaging.hasStructuredReplyPayload!({
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
    mocks.handleAction.mockResolvedValueOnce({ messages: [], hasMore: false });
    await slackPlugin.actions!.handleAction!({
      action: "read",
      channel: "slack",
      accountId: "default",
      cfg: {},
      params: { channelId: "C123", threadId: THREAD_TS, messageId: "1712345678.654321" },
    });

    expect(callRecord(mocks.handleAction)).toMatchObject({
      action: "readMessages",
      channelId: "C123",
      threadId: THREAD_TS,
      messageId: "1712345678.654321",
    });
    expect(callArg(mocks.handleAction, 1)).toEqual({});
    expect(callArg(mocks.handleAction, 2)).toBeUndefined();
  });

  it.each(["send", "upload-file"] as const)(
    "keeps host media authority separate from forged tool context for %s",
    async (action) => {
      mocks.handleAction.mockResolvedValueOnce({ ok: true });
      const mediaAccess = {
        localRoots: ["/tmp/workspace-agent"],
        readFile: vi.fn(async () => Buffer.from("trusted")),
        workspaceDir: "/tmp/workspace-agent",
      };
      const forgedReadFile = vi.fn(async () => Buffer.from("forged"));
      const host = action === "send";
      await slackPlugin.actions!.handleAction!({
        action,
        channel: "slack",
        accountId: "default",
        cfg: {},
        params: host
          ? { to: "channel:C123", message: "render", media: "renders/file.wav" }
          : { to: "channel:C123", filePath: "renders/file.wav" },
        ...(host
          ? {
              mediaAccess,
              mediaLocalRoots: mediaAccess.localRoots,
              conversationReadOrigin: "delegated",
              requesterAccountId: "default",
              requesterSenderId: "U123",
            }
          : {}),
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
      if (host) {
        expect(callRecord(mocks.handleAction).action).toBe("sendMessage");
      }
      const context = callRecord(mocks.handleAction, 2);
      expect(context.mediaAccess).toBe(host ? mediaAccess : undefined);
      expect(context).toMatchObject({
        mediaLocalRoots: host ? mediaAccess.localRoots : undefined,
        mediaReadFile: undefined,
        conversationReadOrigin: host ? "delegated" : undefined,
        requesterAccountId: host ? "default" : undefined,
        requesterSenderId: host ? "U123" : undefined,
        currentChannelId: "C123",
      });
    },
  );
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
        { accountId: "work", ...(identity === "user" ? { identity } : {}) },
      );
    },
  );

  it.each([
    {
      name: "bot token warning",
      probe: {
        ok: true,
        warning: "Slack bot token is a user token",
        bot: { id: "UUSER", name: "human-installer" },
        team: { id: "T1", name: "OpenClaw" },
      },
      expected: [
        { text: "Warning: Slack bot token is a user token", tone: "warn" },
        { text: "Bot: @human-installer" },
        { text: "Team: OpenClaw (T1)" },
      ],
    },
    {
      name: "human identity",
      probe: {
        ok: true,
        user: { id: "U12345678", name: "test-human" },
        team: { id: "T12345678", name: "Test Team" },
      },
      expected: [
        { text: "User identity: @test-human (U12345678)" },
        { text: "Team: Test Team (T12345678)" },
      ],
    },
  ])("renders $name in capabilities output", ({ probe, expected }) => {
    expect(slackPlugin.status?.formatCapabilitiesProbe?.({ probe })).toStrictEqual(expected);
  });

  it("matches the workspace-qualified session identity produced by Enterprise ingress", async () => {
    const channelRoute = await route({
      target: "team:T123:channel:C456",
      currentSessionKey: "agent:main:slack:channel:team:t123:channel:c456:thread:1712345678.123456",
    });
    const dmRoute = await route({
      accountId: "default",
      target: "team:T123:user:U456",
    });

    expect(channelRoute).toMatchObject({
      baseSessionKey: "agent:main:slack:channel:team:t123:channel:c456",
      sessionKey: "agent:main:slack:channel:team:t123:channel:c456:thread:1712345678.123456",
      threadId: THREAD_TS,
      to: "team:T123:channel:C456",
    });
    expect(dmRoute).toMatchObject({
      baseSessionKey: "agent:main:main:account:default:team:t123",
      to: "team:T123:user:U456",
    });
  });

  it.each(["heartbeat-owner", undefined] as const)(
    "limits Enterprise workspace discovery to owner heartbeats: %s",
    async (deliveryPurpose) => {
      const installation = registerSlackInstallationState("default", "enterprise");
      mocks.userInfo.mockResolvedValue({
        ok: true,
        user: { id: "U12345678", enterprise_user: { teams: ["T22222222", "T11111111"] } },
      });
      mocks.teamsList.mockResolvedValue({
        ok: true,
        teams: [{ id: "T22222222" }, { id: "T11111111" }],
      });
      try {
        const resolved = await route({
          cfg: slackConfig({ botToken: "sending-fixture" }),
          target: "user:u12345678",
          deliveryPurpose,
        });
        if (!deliveryPurpose) {
          expect(resolved).toMatchObject({ to: "user:u12345678" });
          expect(mocks.userInfo).not.toHaveBeenCalled();
          expect(mocks.teamsList).not.toHaveBeenCalled();
          return;
        }
        expect(resolved).toMatchObject({
          baseSessionKey: "agent:main:main:account:default:team:t11111111",
          to: "team:T11111111:user:U12345678",
          recipientSessionExact: true,
        });
        expect(mocks.userInfo).toHaveBeenCalledExactlyOnceWith({ user: "U12345678" });
        expect(mocks.conversationOpen).not.toHaveBeenCalled();
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
      mocks.conversationInfo.mockResolvedValueOnce({ channel });
      const resolved = await route({
        cfg: {
          ...slackConfig({ botToken: "xoxb-test", appToken: "xapp-test" }),
          session: { dmScope: "per-channel-peer" },
        },
        target,
        threadId: "1778110574.653649",
      });
      if (expected) {
        expect(resolved).toMatchObject(expected);
      } else {
        expect(resolved).toBeNull();
      }
      expect(mocks.conversationInfo).toHaveBeenCalledWith({ channel: channel.id });
      expect(mocks.conversationOpen).not.toHaveBeenCalled();
    },
  );
});

it("folds comparison, delivery, and session identities", () => {
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

  expect(result).toMatchObject({
    policy: "allowlist",
    allowFrom: ["  slack:U123  "],
    policyPath: "channels.slack.dmPolicy",
    allowFromPath: "channels.slack.",
  });
  expect(result.normalizeEntry?.("  slack:U123  ")).toBe("U123");
  expect(result.normalizeEntry?.("  user:U999  ")).toBe("U999");
});

describe("slackPlugin outbound", () => {
  const cfg = slackConfig({ botToken: "xoxb-test", appToken: "xapp-test" });
  type Payload = Parameters<
    NonNullable<NonNullable<typeof slackPlugin.outbound>["sendPayload"]>
  >[0]["payload"];
  const sendPayload = (
    payload: Payload,
    sendSlack: ReturnType<typeof vi.fn>,
    to = "channel:C123",
  ) =>
    outbound.sendPayload!({
      cfg,
      to,
      text: "",
      accountId: "default",
      payload,
      deps: { sendSlack },
    });

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
    await outbound.sendText!({
      cfg,
      to: "C123",
      text: "heartbeat alert",
      accountId: "default",
      identity: { name: "Pulse", emoji: "📟" },
      deliveryQueueId: "queue-1",
    });

    expect(mocks.sendMessage).toHaveBeenCalledWith(
      "C123",
      "heartbeat alert",
      expect.objectContaining({
        deliveryQueueId: "queue-1",
        identity: { username: "Pulse", iconUrl: undefined, iconEmoji: "📟" },
      }),
    );
  });

  it("uses the workspace-partitioned write-client cache for Grid session status", async () => {
    const target = {
      cfg: slackConfig({ botToken: "xoxb-test" }),
      to: "team:T123:channel:C456",
      accountId: "default",
      threadId: THREAD_TS,
    };

    await slackPlugin.heartbeat!.sendTyping!(target);
    await slackPlugin.heartbeat!.clearTyping!(target);

    expect(mocks.writeClient).toHaveBeenNthCalledWith(1, "xoxb-test", { teamId: "T123" });
    expect(mocks.writeClient).toHaveBeenNthCalledWith(2, "xoxb-test", { teamId: "T123" });
    expect(mocks.resolveDm).not.toHaveBeenCalled();
    expect(mocks.sessionCall.mock.calls).toEqual(
      ["processing", "active"].map((status) => [
        "agents.sessions.setStatus",
        { token: "xoxb-test", channel_id: "C456", thread_ts: THREAD_TS, status },
      ]),
    );
  });

  it("resolves user targets to concrete DM channels for session status", async () => {
    await slackPlugin.heartbeat!.sendTyping!({
      cfg,
      to: "user:u09g2dj0275",
      accountId: "default",
      threadId: THREAD_TS,
    });

    expect(mocks.resolveDm).toHaveBeenCalledWith({
      client: expect.any(Object),
      userId: "U09G2DJ0275",
      accountId: "default",
      token: "xoxb-test",
    });
    expect(mocks.sessionCall).toHaveBeenCalledWith("agents.sessions.setStatus", {
      token: "xoxb-test",
      channel_id: "D123",
      thread_ts: THREAD_TS,
      status: "processing",
    });
  });

  it("auto-threads a DM target after target resolution strips its user prefix", async () => {
    const resolved = await messaging.targetResolver!.resolveTarget!({
      cfg,
      accountId: "default",
      input: "user:U123",
      normalized: "user:u123",
    });

    expect(resolved).toMatchObject({ to: "U123", kind: "user" });
    expect(
      threading.resolveAutoThreadId!({
        cfg,
        to: resolved?.to ?? "",
        toolContext: {
          currentChannelId: "D123",
          currentMessagingTarget: "user:U123",
          currentThreadTs: THREAD_TS,
          replyToMode: "all",
        },
      }),
    ).toBe(THREAD_TS);
  });

  it("does not stringify numeric thread ids in tool context", () => {
    const context = threading.buildToolContext!({
      cfg,
      context: { To: "channel:C123", MessageThreadId: 1712345678.123456 },
    });

    expect(context?.currentThreadTs).toBeUndefined();
  });

  const off = { chatType: "channel", replyToMode: "off" } as const;
  it.each([
    ["internal ID", "msg-internal-1", THREAD_TS, undefined, undefined, THREAD_TS],
    ["off without thread", "9999999999.999999", undefined, off, undefined, null],
    ["inherited child", "1712345688.654321", THREAD_TS, undefined, false, THREAD_TS],
    ["off with thread", "9999999999.999999", THREAD_TS, off, undefined, THREAD_TS],
  ] as const)(
    "resolves %s reply transport",
    (_name, replyToId, threadId, replyDelivery, replyToIsExplicit, expected) => {
      expect(
        threading.resolveReplyTransport!({
          cfg,
          replyToId,
          threadId,
          replyDelivery,
          replyToIsExplicit,
        }),
      ).toEqual({ replyToId: expected, threadId: null });
    },
  );

  it("renders shared interactive payloads into Slack Block Kit via plugin outbound", async () => {
    const sendSlack = vi.fn().mockResolvedValue({ messageId: "m-interactive" });

    const result = await sendPayload(
      {
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
      sendSlack,
      "user:U123",
    );

    expect(callArg(sendSlack)).toBe("user:U123");
    expect(callArg(sendSlack, 1)).toBe(
      "Slack interactive smoke.\n\nApprove\nReject\n\nChoose a target\nCanary\nProduction",
    );
    expect(callRecord(sendSlack, 2).blocks).toMatchObject([
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

      const result = await sendPayload(payload, sendSlack);
      const batches = sendSlack.mock.calls.map((_call, index) =>
        requireArray(callRecord(sendSlack, 2, index).blocks, "Slack blocks"),
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

    const result = await sendPayload(
      {
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
      sendSlack,
    );

    expect(sendSlack).toHaveBeenCalledTimes(3);
    expect(result.messageId).toBe("m-final");
    expect(result.receipt?.platformMessageIds).toEqual(["m-upload", "m-question", "m-final"]);
    expect(result.receipt?.parts.map((part) => part.index)).toEqual([0, 1, 2]);
    expect(result.meta).toEqual({ ...questionMeta, slackQuestionMessageId: "m-question" });
  });
});

it("lists configured peers without throwing a ReferenceError", async () => {
  const listPeers = slackPlugin.directory!.listPeers!;

  await expect(
    listPeers({ cfg: slackConfig({ dms: { U123: {} } }), runtime: createRuntimeEnv() }),
  ).resolves.toEqual([{ id: "user:u123", kind: "user" }]);
});

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

describe("slackPlugin config", () => {
  it.each([
    {
      name: "Socket Mode bot without an app token",
      slack: { mode: "socket" as const, botToken: "xoxb-socket" },
      configured: false,
      snapshot: {},
    },
    {
      name: "Socket Mode user",
      slack: { postAs: "user" as const, userToken: "test-user-token", appToken: "test-app-token" },
      configured: true,
      snapshot: {
        identity: "user",
        userTokenSource: "config",
        userTokenStatus: "available",
        appTokenSource: "config",
      },
    },
    {
      name: "HTTP user",
      slack: {
        postAs: "user" as const,
        mode: "http" as const,
        userToken: "test-user-token",
        signingSecret: "test-signing-secret",
      },
      configured: true,
      snapshot: {
        identity: "user",
        userTokenSource: "config",
        userTokenStatus: "available",
        signingSecretSource: "config",
      },
    },
  ])("reports credential readiness for $name", async ({ slack, configured, snapshot }) => {
    const result = await getSlackConfiguredState(slackConfig(slack));
    expect(result.configured).toBe(configured);
    expect(result.snapshot).toMatchObject({ configured, ...snapshot });
  });
});

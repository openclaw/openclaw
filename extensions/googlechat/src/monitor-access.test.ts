import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";

const createChannelPairingController = vi.hoisted(() => vi.fn());
const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const resolveAllowlistProviderRuntimeGroupPolicy = vi.hoisted(() => vi.fn());
const resolveDefaultGroupPolicy = vi.hoisted(() => vi.fn());
const warnMissingProviderGroupPolicyFallbackOnce = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/channel-pairing", () => ({ createChannelPairingController }));
vi.mock("openclaw/plugin-sdk/dangerous-name-runtime", () => ({ isDangerousNameMatchingEnabled }));
vi.mock("openclaw/plugin-sdk/runtime-group-policy", () => ({
  GROUP_POLICY_BLOCKED_LABEL: { space: "space" },
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
}));

// mock-isolation: Record access-policy replies without contacting the Google Chat API.
vi.mock("./api.js", () => ({ sendGoogleChatMessage }));

function createCore() {
  return {
    channel: {
      inbound: { ingress: createPluginRuntimeMock().channel.inbound.ingress },
      commands: {
        shouldComputeCommandAuthorized: vi.fn(() => false),
        resolveCommandAuthorizedFromAuthorizers: vi.fn(() => false),
        shouldHandleTextCommands: vi.fn(() => false),
        isControlCommandMessage: vi.fn(() => false),
      },
      text: { hasControlCommand: vi.fn(() => false) },
    },
  };
}

function primeCommonDefaults() {
  isDangerousNameMatchingEnabled.mockReturnValue(false);
  resolveDefaultGroupPolicy.mockReturnValue("allowlist");
  resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
    groupPolicy: "allowlist",
    providerMissingFallbackApplied: false,
  });
  createChannelPairingController.mockReturnValue({
    readAllowFromStore: vi.fn(async () => []),
    issueChallenge: vi.fn(),
  });
}

let applyGoogleChatInboundAccessPolicy: typeof import("./monitor-access.js").applyGoogleChatInboundAccessPolicy;

function account(config: ResolvedGoogleChatAccount["config"]) {
  return { accountId: "default", config } as ResolvedGoogleChatAccount;
}

const mention = (name: string) => ({
  annotations: [{ type: "USER_MENTION", userMention: { user: { name } } }],
});

async function applyInboundAccessPolicy(
  overrides: Partial<Parameters<typeof applyGoogleChatInboundAccessPolicy>[0]>,
) {
  return applyGoogleChatInboundAccessPolicy({
    account: account({}),
    config: { channels: { googlechat: {} }, commands: { useAccessGroups: true } } as never,
    core: createCore() as never,
    space: { name: "spaces/AAA", displayName: "Team Room" } as never,
    message: { annotations: [] } as never,
    isGroup: true,
    rawBody: "hello team",
    logVerbose: vi.fn(),
    senderId: "users/alice",
    senderName: "Alice",
    senderEmail: "alice@example.com",
    ...overrides,
  } as never);
}

async function expectBlocked(
  overrides: Partial<Parameters<typeof applyGoogleChatInboundAccessPolicy>[0]>,
  ...reasons: string[]
) {
  const logVerbose = vi.fn();
  await expect(applyInboundAccessPolicy({ ...overrides, logVerbose })).resolves.toEqual({
    ok: false,
  });
  for (const reason of reasons) {
    expect(logVerbose).toHaveBeenCalledWith(reason);
  }
}

describe("googlechat inbound access policy", () => {
  beforeEach(primeCommonDefaults);
  beforeAll(async () => {
    ({ applyGoogleChatInboundAccessPolicy } = await import("./monitor-access.js"));
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/channel-pairing");
    vi.doUnmock("openclaw/plugin-sdk/dangerous-name-runtime");
    vi.doUnmock("openclaw/plugin-sdk/runtime-group-policy");
    vi.doUnmock("./api.js");
    vi.resetModules();
  });

  it.each([
    ["blocks email matching by default", false, "jane@example.com", false],
    ["opts into email matching", true, "jane@example.com", true],
    ["rejects users/<email> aliases", true, "users/jane@example.com", false],
  ] as const)("%s", async (_name, allowNameMatching, entry, ok) => {
    isDangerousNameMatchingEnabled.mockReturnValue(allowNameMatching);
    const result = await applyInboundAccessPolicy({
      isGroup: false,
      account: account({ dmPolicy: "allowlist", allowFrom: [entry] }),
      senderId: "users/123",
      senderEmail: "Jane@Example.com",
    });
    expect(result.ok).toBe(ok);
  });

  it("issues a pairing challenge for unauthorized DMs in pairing mode", async () => {
    const now = Date.parse("2026-05-09T06:35:00.000Z");
    const issueChallenge = vi.fn(async ({ onCreated, sendPairingReply }) => {
      onCreated?.();
      await sendPairingReply("pairing text");
    });
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge,
    });
    sendGoogleChatMessage.mockResolvedValue({ ok: true });

    const statusSink = vi.fn();
    const pairingAccount = account({ dmPolicy: "pairing" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await expect(
        applyInboundAccessPolicy({
          account: pairingAccount,
          isGroup: false,
          senderId: "users/abc",
          contextBinding: {
            agentId: "main",
            sessionKey: "agent:main:googlechat:direct:users/abc",
            inboundEventKind: "user_request",
          },
          statusSink,
        }),
      ).resolves.toEqual({ ok: false });

      expect(issueChallenge).toHaveBeenCalledTimes(1);
      expect(sendGoogleChatMessage).toHaveBeenCalledWith({
        account: pairingAccount,
        space: "spaces/AAA",
        text: "pairing text",
      });
      expect(statusSink).toHaveBeenCalledWith({ lastOutboundAt: now });
    } finally {
      clock.mockRestore();
    }
  });

  it("allows group traffic when sender and mention gates pass", async () => {
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.resolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const result = await applyInboundAccessPolicy({
      account: account({
        botUser: "users/app-bot",
        groups: {
          "spaces/AAA": {
            users: ["users/alice"],
            requireMention: true,
            systemPrompt: " group prompt ",
          },
        },
      }),
      core: core as never,
      message: mention("users/app-bot"),
    });

    expect(result).toMatchObject({
      ok: true,
      channelIngress: {
        ingress: { admission: "dispatch" },
        senderAccess: { decision: "allow" },
      },
      commandAuthorized: true,
      effectiveWasMentioned: true,
      groupSystemPrompt: "group prompt",
    });
  });

  it.each([
    {
      name: "does not borrow DM allowlists for routed spaces",
      config: {
        dmPolicy: "allowlist",
        allowFrom: ["users/alice"],
        groups: { "spaces/AAA": { enabled: true } },
      },
      policy: "allowlist",
      reason:
        "drop group message (sender policy blocked, reason=groupPolicy=allowlist (empty allowlist), space=spaces/AAA)",
    },
    {
      name: "keeps configured users sender-scoped under open group policy",
      config: {
        groupPolicy: "open",
        groups: { "spaces/AAA": { users: ["users/bob"], requireMention: false } },
      },
      policy: "open",
      reason: "drop group message (sender not allowed, users/alice)",
    },
  ] satisfies Array<{
    name: string;
    config: ResolvedGoogleChatAccount["config"];
    policy: string;
    reason: string;
  }>)("$name", async ({ config, policy, reason }) => {
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: policy,
      providerMissingFallbackApplied: false,
    });
    await expectBlocked({ account: account(config) }, reason);
  });

  it("drops unauthorized group control commands", async () => {
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.isControlCommandMessage.mockReturnValue(true);

    await expectBlocked(
      {
        core: core as never,
        account: account({ groups: { "spaces/AAA": { requireMention: false } } }),
        rawBody: "/admin",
      },
      "googlechat: drop control command from users/alice",
    );
  });

  it("does not match group policy by mutable space displayName when the stable id differs", async () => {
    await expectBlocked(
      {
        account: account({
          groups: {
            "Finance Ops": {
              users: ["users/alice"],
              requireMention: true,
            },
          },
        }),
        space: { name: "spaces/BBB", displayName: "Finance Ops" } as never,
        message: mention("users/app"),
      },
      "Deprecated Google Chat group key detected: group routing now requires stable space ids (spaces/<spaceId>). Update channels.googlechat.groups keys: Finance Ops",
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });

  it("fails closed instead of falling back to wildcard when a deprecated room key matches", async () => {
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });

    await expectBlocked(
      {
        account: account({
          groupPolicy: "open",
          groups: {
            "*": { users: ["users/alice"] },
            "Finance Ops": { enabled: false, users: ["users/bob"] },
          },
        }),
        space: { name: "spaces/BBB", displayName: "Finance Ops" } as never,
      },
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });
});

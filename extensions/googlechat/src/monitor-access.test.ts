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

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

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
      text: {
        hasControlCommand: vi.fn(() => false),
      },
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
  warnMissingProviderGroupPolicyFallbackOnce.mockReturnValue(undefined);
}

const baseAccessConfig = {
  channels: { googlechat: {} },
  commands: { useAccessGroups: true },
} as const;

const defaultSender = {
  senderId: "users/alice",
  senderName: "Alice",
  senderEmail: "alice@example.com",
} as const;

let applyGoogleChatInboundAccessPolicy: typeof import("./monitor-access.js").applyGoogleChatInboundAccessPolicy;

function allowInboundGroupTraffic() {
  createChannelPairingController.mockReturnValue({
    readAllowFromStore: vi.fn(async () => []),
    issueChallenge: vi.fn(),
  });
}

function account(config: ResolvedGoogleChatAccount["config"]) {
  return { accountId: "default", config } as ResolvedGoogleChatAccount;
}

async function applyInboundAccessPolicy(
  overrides: Partial<Parameters<typeof applyGoogleChatInboundAccessPolicy>[0]>,
) {
  return applyGoogleChatInboundAccessPolicy({
    account: account({}),
    config: baseAccessConfig as never,
    core: createCore() as never,
    space: { name: "spaces/AAA", displayName: "Team Room" } as never,
    message: { annotations: [] } as never,
    isGroup: true,
    rawBody: "hello team",
    logVerbose: vi.fn(),
    ...defaultSender,
    ...overrides,
  } as never);
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
    {
      name: "blocks raw email entries when dangerous name matching is disabled",
      allowNameMatching: false,
      allowFrom: ["jane@example.com"],
      senderId: "users/123",
      ok: false,
    },
    {
      name: "matches raw email entries when dangerous name matching is enabled",
      allowNameMatching: true,
      allowFrom: ["jane@example.com"],
      senderId: "users/123",
      ok: true,
    },
    {
      name: "does not treat users/<email> entries as email allowlist entries",
      allowNameMatching: true,
      allowFrom: ["users/jane@example.com"],
      senderId: "users/123",
      ok: false,
    },
  ])("$name", async ({ allowNameMatching, allowFrom, senderId, ok }) => {
    isDangerousNameMatchingEnabled.mockReturnValue(allowNameMatching);
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });

    const result = await applyInboundAccessPolicy({
      isGroup: false,
      account: account({ dmPolicy: "allowlist", allowFrom }),
      senderId,
      senderEmail: "Jane@Example.com",
    });
    expect(result.ok).toBe(ok);
  });

  it("issues a pairing challenge for unauthorized DMs in pairing mode", async () => {
    const now = new Date("2026-05-09T06:35:00.000Z").getTime();
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
    const logVerbose = vi.fn();
    const pairingAccount = account({ dmPolicy: "pairing" });

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await expect(
        applyInboundAccessPolicy({
          account: pairingAccount,
          config: {
            channels: { googlechat: {} },
          } as never,
          space: { name: "spaces/AAA", displayName: "DM" } as never,
          isGroup: false,
          senderId: "users/abc",
          rawBody: "hello",
          contextBinding: {
            agentId: "main",
            sessionKey: "agent:main:googlechat:direct:users/abc",
            inboundEventKind: "user_request",
          },
          statusSink,
          logVerbose,
        }),
      ).resolves.toEqual({ ok: false });

      expect(issueChallenge).toHaveBeenCalledTimes(1);
      expect(sendGoogleChatMessage).toHaveBeenCalledWith({
        account: pairingAccount,
        space: "spaces/AAA",
        text: "pairing text",
      });
      expect(statusSink).toHaveBeenCalledWith({
        lastOutboundAt: now,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows group traffic when sender and mention gates pass", async () => {
    allowInboundGroupTraffic();
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
      message: {
        annotations: [
          {
            type: "USER_MENTION",
            userMention: { user: { name: "users/app-bot" } },
          },
        ],
      } as never,
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

  it("preserves allowlist group policy when a routed space has no sender allowlist", async () => {
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: account({
          dmPolicy: "allowlist",
          allowFrom: ["users/alice"],
          groups: { "spaces/AAA": { enabled: true } },
        }),
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (sender policy blocked, reason=groupPolicy=allowlist (empty allowlist), space=spaces/AAA)",
    );
  });

  it("keeps configured space users sender-scoped when group policy is open", async () => {
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: account({
          groupPolicy: "open",
          groups: { "spaces/AAA": { users: ["users/bob"], requireMention: false } },
        }),
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith("drop group message (sender not allowed, users/alice)");
  });

  it("drops unauthorized group control commands", async () => {
    allowInboundGroupTraffic();
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.isControlCommandMessage.mockReturnValue(true);
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        core: core as never,
        account: account({ groups: { "spaces/AAA": { requireMention: false } } }),
        rawBody: "/admin",
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith("googlechat: drop control command from users/alice");
  });

  it("does not match group policy by mutable space displayName when the stable id differs", async () => {
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: account({
          groups: {
            "Finance Ops": {
              users: ["users/alice"],
              requireMention: true,
              systemPrompt: "finance-only prompt",
            },
          },
        }),
        space: { name: "spaces/BBB", displayName: "Finance Ops" } as never,
        message: {
          annotations: [
            {
              type: "USER_MENTION",
              userMention: { user: { name: "users/app" } },
            },
          ],
        } as never,
        rawBody: "show quarter close status",
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "Deprecated Google Chat group key detected: group routing now requires stable space ids (spaces/<spaceId>). Update channels.googlechat.groups keys: Finance Ops",
    );
    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });

  it("fails closed instead of falling back to wildcard when a deprecated room key matches", async () => {
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    allowInboundGroupTraffic();
    const logVerbose = vi.fn();

    await expect(
      applyInboundAccessPolicy({
        account: account({
          groupPolicy: "open",
          groups: {
            "*": { users: ["users/alice"] },
            "Finance Ops": { enabled: false, users: ["users/bob"] },
          },
        }),
        space: { name: "spaces/BBB", displayName: "Finance Ops" } as never,
        rawBody: "show quarter close status",
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });
});

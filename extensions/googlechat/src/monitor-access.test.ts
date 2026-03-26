import { describe, expect, it, vi } from "vitest";

const createChannelPairingController = vi.hoisted(() => vi.fn());
const evaluateGroupRouteAccessForPolicy = vi.hoisted(() => vi.fn());
const isDangerousNameMatchingEnabled = vi.hoisted(() => vi.fn());
const resolveAllowlistProviderRuntimeGroupPolicy = vi.hoisted(() => vi.fn());
const resolveDefaultGroupPolicy = vi.hoisted(() => vi.fn());
const resolveDmGroupAccessWithLists = vi.hoisted(() => vi.fn());
const resolveMentionGatingWithBypass = vi.hoisted(() => vi.fn());
const resolveSenderScopedGroupPolicy = vi.hoisted(() => vi.fn());
const warnMissingProviderGroupPolicyFallbackOnce = vi.hoisted(() => vi.fn());
const sendGoogleChatMessage = vi.hoisted(() => vi.fn());

vi.mock("../runtime-api.js", () => ({
  GROUP_POLICY_BLOCKED_LABEL: { space: "space" },
  createChannelPairingController,
  evaluateGroupRouteAccessForPolicy,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveDmGroupAccessWithLists,
  resolveMentionGatingWithBypass,
  resolveSenderScopedGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
}));

vi.mock("./api.js", () => ({
  sendGoogleChatMessage,
}));

function createCore() {
  return {
    channel: {
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
  resolveSenderScopedGroupPolicy.mockImplementation(({ groupPolicy }) => groupPolicy);
  evaluateGroupRouteAccessForPolicy.mockReturnValue({
    allowed: true,
  });
  warnMissingProviderGroupPolicyFallbackOnce.mockReturnValue(undefined);
}

describe("googlechat inbound access policy", () => {
  it("issues a pairing challenge for unauthorized DMs in pairing mode", async () => {
    primeCommonDefaults();
    const issueChallenge = vi.fn(async ({ onCreated, sendPairingReply }) => {
      onCreated?.();
      await sendPairingReply("pairing text");
    });
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge,
    });
    resolveDmGroupAccessWithLists.mockReturnValue({
      decision: "pairing",
      reason: "pairing_required",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
    });
    sendGoogleChatMessage.mockResolvedValue({ ok: true });

    const { applyGoogleChatInboundAccessPolicy } = await import("./monitor-access.js");
    const statusSink = vi.fn();
    const logVerbose = vi.fn();

    await expect(
      applyGoogleChatInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            dm: { policy: "pairing" },
          },
        } as never,
        config: {
          channels: { googlechat: {} },
        } as never,
        core: createCore() as never,
        space: { name: "spaces/AAA", displayName: "DM" } as never,
        message: { annotations: [] } as never,
        isGroup: false,
        senderId: "users/abc",
        senderName: "Alice",
        senderEmail: "alice@example.com",
        rawBody: "hello",
        statusSink,
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(issueChallenge).toHaveBeenCalledTimes(1);
    expect(sendGoogleChatMessage).toHaveBeenCalledWith({
      account: expect.anything(),
      space: "spaces/AAA",
      text: "pairing text",
    });
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({
        lastOutboundAt: expect.any(Number),
      }),
    );
  });

  it("allows group traffic when sender and mention gates pass", async () => {
    primeCommonDefaults();
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    resolveDmGroupAccessWithLists.mockReturnValue({
      decision: "allow",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: ["users/alice"],
    });
    resolveMentionGatingWithBypass.mockReturnValue({
      shouldSkip: false,
      effectiveWasMentioned: true,
    });
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.resolveCommandAuthorizedFromAuthorizers.mockReturnValue(true);

    const { applyGoogleChatInboundAccessPolicy } = await import("./monitor-access.js");

    await expect(
      applyGoogleChatInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            botUser: "users/app-bot",
            groups: {
              "spaces/AAA": {
                users: ["users/alice"],
                requireMention: true,
                systemPrompt: " group prompt ",
              },
            },
          },
        } as never,
        config: {
          channels: { googlechat: {} },
          commands: { useAccessGroups: true },
        } as never,
        core: core as never,
        space: { name: "spaces/AAA", displayName: "Team Room" } as never,
        message: {
          annotations: [
            {
              type: "USER_MENTION",
              userMention: { user: { name: "users/app-bot" } },
            },
          ],
        } as never,
        isGroup: true,
        senderId: "users/alice",
        senderName: "Alice",
        senderEmail: "alice@example.com",
        rawBody: "hello team",
        logVerbose: vi.fn(),
      }),
    ).resolves.toEqual({
      ok: true,
      commandAuthorized: true,
      effectiveWasMentioned: true,
      groupSystemPrompt: "group prompt",
    });
  });

  it("drops unauthorized group control commands", async () => {
    primeCommonDefaults();
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    resolveDmGroupAccessWithLists.mockReturnValue({
      decision: "allow",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: [],
    });
    resolveMentionGatingWithBypass.mockReturnValue({
      shouldSkip: false,
      effectiveWasMentioned: false,
    });
    const core = createCore();
    core.channel.commands.shouldComputeCommandAuthorized.mockReturnValue(true);
    core.channel.commands.resolveCommandAuthorizedFromAuthorizers.mockReturnValue(false);
    core.channel.commands.isControlCommandMessage.mockReturnValue(true);
    const logVerbose = vi.fn();

    const { applyGoogleChatInboundAccessPolicy } = await import("./monitor-access.js");

    await expect(
      applyGoogleChatInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {},
        } as never,
        config: {
          channels: { googlechat: {} },
          commands: { useAccessGroups: true },
        } as never,
        core: core as never,
        space: { name: "spaces/AAA", displayName: "Team Room" } as never,
        message: { annotations: [] } as never,
        isGroup: true,
        senderId: "users/alice",
        senderName: "Alice",
        senderEmail: "alice@example.com",
        rawBody: "/admin",
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith("googlechat: drop control command from users/alice");
  });

  it("does not match group policy by mutable space displayName when the stable id differs", async () => {
    primeCommonDefaults();
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    resolveDmGroupAccessWithLists.mockReturnValue({
      decision: "allow",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: ["users/alice"],
    });
    resolveMentionGatingWithBypass.mockReturnValue({
      shouldSkip: false,
      effectiveWasMentioned: true,
    });
    const logVerbose = vi.fn();

    const { applyGoogleChatInboundAccessPolicy } = await import("./monitor-access.js");

    await expect(
      applyGoogleChatInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            groups: {
              "Finance Ops": {
                users: ["users/alice"],
                requireMention: true,
                systemPrompt: "finance-only prompt",
              },
            },
          },
        } as never,
        config: {
          channels: { googlechat: {} },
          commands: { useAccessGroups: true },
        } as never,
        core: createCore() as never,
        space: { name: "spaces/BBB", displayName: "Finance Ops" } as never,
        message: {
          annotations: [
            {
              type: "USER_MENTION",
              userMention: { user: { name: "users/app" } },
            },
          ],
        } as never,
        isGroup: true,
        senderId: "users/alice",
        senderName: "Alice",
        senderEmail: "alice@example.com",
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
    primeCommonDefaults();
    resolveAllowlistProviderRuntimeGroupPolicy.mockReturnValue({
      groupPolicy: "open",
      providerMissingFallbackApplied: false,
    });
    createChannelPairingController.mockReturnValue({
      readAllowFromStore: vi.fn(async () => []),
      issueChallenge: vi.fn(),
    });
    resolveDmGroupAccessWithLists.mockReturnValue({
      decision: "allow",
      effectiveAllowFrom: [],
      effectiveGroupAllowFrom: ["users/alice"],
    });
    resolveMentionGatingWithBypass.mockReturnValue({
      shouldSkip: false,
      effectiveWasMentioned: true,
    });
    const logVerbose = vi.fn();

    const { applyGoogleChatInboundAccessPolicy } = await import("./monitor-access.js");

    await expect(
      applyGoogleChatInboundAccessPolicy({
        account: {
          accountId: "default",
          config: {
            groupPolicy: "open",
            groups: {
              "*": {
                users: ["users/alice"],
              },
              "Finance Ops": {
                allow: false,
                users: ["users/bob"],
              },
            },
          },
        } as never,
        config: {
          channels: { googlechat: {} },
          commands: { useAccessGroups: true },
        } as never,
        core: createCore() as never,
        space: { name: "spaces/BBB", displayName: "Finance Ops" } as never,
        message: { annotations: [] } as never,
        isGroup: true,
        senderId: "users/alice",
        senderName: "Alice",
        senderEmail: "alice@example.com",
        rawBody: "show quarter close status",
        logVerbose,
      }),
    ).resolves.toEqual({ ok: false });

    expect(logVerbose).toHaveBeenCalledWith(
      "drop group message (deprecated mutable group key matched, space=spaces/BBB)",
    );
  });
});

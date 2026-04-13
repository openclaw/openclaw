import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { handleNextcloudTalkInboundReaction } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundReaction } from "./types.js";

const {
  createChannelPairingControllerMock,
  readStoreAllowFromForDmPolicyMock,
  resolveDmGroupAccessWithCommandGateMock,
  resolveAllowlistProviderRuntimeGroupPolicyMock,
  resolveDefaultGroupPolicyMock,
  warnMissingProviderGroupPolicyFallbackOnceMock,
} = vi.hoisted(() => {
  return {
    createChannelPairingControllerMock: vi.fn(),
    readStoreAllowFromForDmPolicyMock: vi.fn(),
    resolveDmGroupAccessWithCommandGateMock: vi.fn(),
    resolveAllowlistProviderRuntimeGroupPolicyMock: vi.fn(),
    resolveDefaultGroupPolicyMock: vi.fn(),
    warnMissingProviderGroupPolicyFallbackOnceMock: vi.fn(),
  };
});

const resolveNextcloudTalkRoomKindMock = vi.hoisted(() => vi.fn());
const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
const resolveAgentRouteMock = vi.hoisted(() =>
  vi.fn(() => ({
    sessionKey: "session:nc:default:user-1",
    accountId: "default",
    agentId: "main",
  })),
);

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    createChannelPairingController: createChannelPairingControllerMock,
    readStoreAllowFromForDmPolicy: readStoreAllowFromForDmPolicyMock,
    resolveDmGroupAccessWithCommandGate: resolveDmGroupAccessWithCommandGateMock,
    resolveAllowlistProviderRuntimeGroupPolicy: resolveAllowlistProviderRuntimeGroupPolicyMock,
    resolveDefaultGroupPolicy: resolveDefaultGroupPolicyMock,
    warnMissingProviderGroupPolicyFallbackOnce: warnMissingProviderGroupPolicyFallbackOnceMock,
  };
});

vi.mock("./room-info.js", async () => {
  const actual = await vi.importActual<typeof import("./room-info.js")>("./room-info.js");
  return {
    ...actual,
    resolveNextcloudTalkRoomKind: resolveNextcloudTalkRoomKindMock,
  };
});

function installRuntime() {
  setNextcloudTalkRuntime({
    channel: {
      routing: {
        resolveAgentRoute: resolveAgentRouteMock,
      },
    },
    system: {
      enqueueSystemEvent: enqueueSystemEventMock,
    },
  } as unknown as PluginRuntime);
}

function createRuntimeEnv() {
  return {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

function createAccount(
  overrides?: Partial<ResolvedNextcloudTalkAccount>,
): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://cloud.example.com",
    secret: "secret",
    secretSource: "config",
    config: {
      dmPolicy: "pairing",
      allowFrom: [],
      groupPolicy: "allowlist",
      groupAllowFrom: [],
    },
    ...overrides,
  };
}

function createReaction(
  overrides?: Partial<NextcloudTalkInboundReaction>,
): NextcloudTalkInboundReaction {
  return {
    action: "added",
    messageId: "msg-1",
    roomToken: "room-1",
    roomName: "Ops",
    senderId: "user-1",
    senderName: "Alice",
    emoji: "👍",
    timestamp: Date.now(),
    isGroupChat: false,
    ...overrides,
  };
}

describe("nextcloud-talk inbound reaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installRuntime();
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("direct");
    resolveDefaultGroupPolicyMock.mockReturnValue("allowlist");
    resolveAllowlistProviderRuntimeGroupPolicyMock.mockReturnValue({
      groupPolicy: "allowlist",
      providerMissingFallbackApplied: false,
    });
    warnMissingProviderGroupPolicyFallbackOnceMock.mockReturnValue(undefined);
    readStoreAllowFromForDmPolicyMock.mockResolvedValue([]);
    createChannelPairingControllerMock.mockReturnValue({
      readStoreForDmPolicy: vi.fn(),
      issueChallenge: vi.fn(),
    });
    resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
      decision: "allow",
      reason: "allow",
      commandAuthorized: false,
      effectiveGroupAllowFrom: [],
    });
  });

  it("enqueues a system event for an allowed DM reaction", async () => {
    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ action: "added", emoji: "👍", messageId: "42" }),
      account: createAccount(),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [text, options] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(text).toContain("Nextcloud Talk reaction added");
    expect(text).toContain("👍");
    expect(text).toContain("message 42");
    expect(options).toMatchObject({
      sessionKey: "session:nc:default:user-1",
      contextKey: "nextcloud-talk:reaction:room-1:42:👍:user-1:added",
    });
  });

  it("enqueues a removed reaction for Undo events in a group room", async () => {
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");
    resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
      decision: "allow",
      reason: "allow",
      commandAuthorized: false,
      effectiveGroupAllowFrom: ["user-1"],
    });

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({
        action: "removed",
        isGroupChat: true,
        roomToken: "room-group",
        roomName: "Ops",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: ["user-1"],
          rooms: { "room-group": {} },
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime: createRuntimeEnv(),
    });

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    const [text, options] = enqueueSystemEventMock.mock.calls[0] ?? [];
    expect(text).toContain("Nextcloud Talk reaction removed");
    expect(text).toContain("Ops");
    expect(options?.contextKey).toBe("nextcloud-talk:reaction:room-group:msg-1:👍:user-1:removed");
  });

  it("drops reactions when the DM/group access gate denies", async () => {
    resolveDmGroupAccessWithCommandGateMock.mockReturnValue({
      decision: "deny",
      reason: "not_allowlisted",
      commandAuthorized: false,
      effectiveGroupAllowFrom: [],
    });
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction(),
      account: createAccount(),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("drop reaction sender user-1"),
    );
  });

  it("drops reactions from the configured bot apiUser (echo suppression)", async () => {
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ senderId: "bot-api-user" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          apiUser: "bot-api-user",
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("drops reactions with empty emoji/messageId/senderId", async () => {
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ emoji: "   " }),
      account: createAccount(),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("drops group reactions in rooms that are not allowlisted", async () => {
    resolveNextcloudTalkRoomKindMock.mockResolvedValue("group");

    const runtime = createRuntimeEnv();
    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({
        isGroupChat: true,
        roomToken: "room-disallowed",
      }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
          rooms: { "room-allowed": {} },
        },
      }),
      config: { channels: { "nextcloud-talk": {} } } as CoreConfig,
      runtime,
    });

    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("drop reaction in room room-disallowed (not allowlisted)"),
    );
  });
});

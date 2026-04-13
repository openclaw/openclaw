import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { clearApprovalStash, lookupApproval, stashApproval } from "./approval-stash.js";
import { handleNextcloudTalkInboundReaction } from "./inbound.js";
import { setNextcloudTalkRuntime } from "./runtime.js";
import type { CoreConfig, NextcloudTalkInboundReaction } from "./types.js";

const resolveApprovalOverGatewayMock = vi.hoisted(() => vi.fn());
const sendMessageNextcloudTalkMock = vi.hoisted(() => vi.fn());
const sendReactionNextcloudTalkMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: resolveApprovalOverGatewayMock,
}));

vi.mock("./send.js", () => ({
  sendMessageNextcloudTalk: sendMessageNextcloudTalkMock,
  sendReactionNextcloudTalk: sendReactionNextcloudTalkMock,
}));

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
      allowFrom: ["user-1"],
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
    messageId: "msg-appr-1",
    roomToken: "room-1",
    roomName: "Ops",
    senderId: "user-1",
    senderName: "Alice",
    emoji: "1️⃣",
    timestamp: Date.now(),
    isGroupChat: false,
    ...overrides,
  };
}

function seedStash(senderAllowed = true, approvalKind: "exec" | "plugin" = "exec"): void {
  stashApproval("default", "room-1", "msg-appr-1", {
    approvalId: "appr-abc123",
    approvalSlug: "appr-ab",
    approvalKind,
    actions: [
      { emoji: "1️⃣", decision: "allow-once" },
      { emoji: "2️⃣", decision: "allow-always" },
      { emoji: "3️⃣", decision: "deny" },
    ],
  });
  // Touch the allowlist shape so tests can vary it; consumer of this helper doesn't need it.
  void senderAllowed;
}

function resolveCfg(allowFrom: readonly string[] = ["user-1"]): CoreConfig {
  return {
    channels: { "nextcloud-talk": { allowFrom: [...allowFrom] } },
  } as CoreConfig;
}

describe("nextcloud-talk inbound reaction → approval flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearApprovalStash();
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
    resolveApprovalOverGatewayMock.mockResolvedValue(undefined);
    sendMessageNextcloudTalkMock.mockResolvedValue({
      messageId: "followup-1",
      roomToken: "room-1",
      timestamp: 1_700_000_000,
    });
  });

  afterEach(() => {
    clearApprovalStash();
  });

  it("dispatches + consumes + posts follow-up when an authorized approver reacts", async () => {
    seedStash();

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ senderId: "user-1", emoji: "1️⃣" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: resolveCfg(),
      runtime: createRuntimeEnv(),
    });

    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledTimes(1);
    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "appr-abc123",
        decision: "allow-once",
        senderId: "user-1",
      }),
    );
    expect(sendMessageNextcloudTalkMock).toHaveBeenCalledTimes(1);
    expect(sendMessageNextcloudTalkMock.mock.calls[0]?.[1]).toContain("Decision recorded");
    expect(sendMessageNextcloudTalkMock.mock.calls[0]?.[1]).toContain("allow-once");
    expect(sendMessageNextcloudTalkMock.mock.calls[0]?.[2]).toMatchObject({
      replyTo: "msg-appr-1",
    });
    expect(lookupApproval("default", "room-1", "msg-appr-1")).toBeUndefined();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("falls through to system event when a non-approver reacts (stash left intact)", async () => {
    seedStash();
    const runtime = createRuntimeEnv();

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ senderId: "user-intruder", senderName: "Mallory", emoji: "1️⃣" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: resolveCfg(),
      runtime,
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(sendMessageNextcloudTalkMock).not.toHaveBeenCalled();
    expect(lookupApproval("default", "room-1", "msg-appr-1")).toBeDefined();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
    expect(runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("unauthorized sender user-intruder"),
    );
  });

  it("falls through for an unrelated emoji on a stashed approval", async () => {
    seedStash();

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ senderId: "user-1", emoji: "🔥" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: resolveCfg(),
      runtime: createRuntimeEnv(),
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(lookupApproval("default", "room-1", "msg-appr-1")).toBeDefined();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("falls through when the reacted message has no stash entry", async () => {
    // No seedStash call — nothing in the map.
    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ messageId: "msg-unstashed", senderId: "user-1", emoji: "1️⃣" }),
      account: createAccount(),
      config: resolveCfg(),
      runtime: createRuntimeEnv(),
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("falls through on removed-reaction events even when a stash entry exists", async () => {
    seedStash();

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ action: "removed", senderId: "user-1", emoji: "1️⃣" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: ["user-1"],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: resolveCfg(),
      runtime: createRuntimeEnv(),
    });

    expect(resolveApprovalOverGatewayMock).not.toHaveBeenCalled();
    expect(lookupApproval("default", "room-1", "msg-appr-1")).toBeDefined();
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });

  it("treats allowFrom=[] as open approvers (every room-allowed sender can decide)", async () => {
    seedStash();

    await handleNextcloudTalkInboundReaction({
      reaction: createReaction({ senderId: "user-guest", senderName: "Guest", emoji: "3️⃣" }),
      account: createAccount({
        config: {
          dmPolicy: "pairing",
          allowFrom: [],
          groupPolicy: "allowlist",
          groupAllowFrom: [],
        },
      }),
      config: resolveCfg([]),
      runtime: createRuntimeEnv(),
    });

    expect(resolveApprovalOverGatewayMock).toHaveBeenCalledWith(
      expect.objectContaining({ decision: "deny", senderId: "user-guest" }),
    );
    expect(lookupApproval("default", "room-1", "msg-appr-1")).toBeUndefined();
  });
});

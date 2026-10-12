import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  checkZaloAuthenticatedMock,
  listZaloFriendsMatchingMock,
  startZaloQrLoginMock,
  waitForZaloQrLoginMock,
} from "./zalo-js.test-mocks.js";
import {
  zalouserAuthAdapter,
  zalouserGroupsAdapter,
  zalouserMessageActions,
  zalouserMessagingAdapter,
  zalouserOutboundAdapter,
  zalouserPairingTextAdapter,
  zalouserResolverAdapter,
  zalouserSecurityAdapter,
} from "./channel.adapters.js";
import { zalouserPlugin } from "./channel.js";

describe("zalouser target classification", () => {
  it("distinguishes users from groups", () => {
    expect(zalouserMessagingAdapter.inferTargetChatType({ to: "user:123" })).toBe("direct");
    expect(zalouserMessagingAdapter.inferTargetChatType({ to: "group:456" })).toBe("group");
  });
});
import { listZalouserDirectoryGroupMembers } from "./directory.js";
import { sendMessageZalouser, sendReactionZalouser } from "./send.js";

vi.mock("./qr-temp-file.js", () => ({
  writeQrDataUrlToTempFile: vi.fn(async () => null),
}));

vi.mock("./send.js", async () => {
  const actual = (await vi.importActual("./send.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessageZalouser: vi.fn(async () => ({ ok: true, messageId: "mid-1" })),
    sendReactionZalouser: vi.fn(async () => ({ ok: true })),
  };
});

const mockSendMessage = vi.mocked(sendMessageZalouser);
const mockSendReaction = vi.mocked(sendReactionZalouser);

function getResolveToolPolicy() {
  const resolveToolPolicy = zalouserGroupsAdapter.resolveToolPolicy;
  if (!resolveToolPolicy) {
    throw new Error("resolveToolPolicy unavailable");
  }
  return resolveToolPolicy;
}

function requireZalouserResolveRequireMention() {
  const resolveRequireMention = zalouserGroupsAdapter.resolveRequireMention;
  if (!resolveRequireMention) {
    throw new Error("resolveRequireMention unavailable");
  }
  return resolveRequireMention;
}

function requireZalouserPairingNormalizer() {
  const normalizeAllowEntry = zalouserPairingTextAdapter.normalizeAllowEntry;
  if (!normalizeAllowEntry) {
    throw new Error("pairing.normalizeAllowEntry unavailable");
  }
  return normalizeAllowEntry;
}

function resolveGroupToolPolicy(
  groups: Record<string, { tools: { allow?: string[]; deny?: string[] } }>,
  groupId: string,
) {
  return getResolveToolPolicy()({
    cfg: {
      channels: {
        zalouser: {
          groups,
        },
      },
    },
    accountId: "default",
    groupId,
    groupChannel: groupId,
  });
}

describe("zalouser outbound", () => {
  it("removes internal tool text while preserving user-visible examples", () => {
    const sanitizeText = zalouserOutboundAdapter.sanitizeText;
    if (!sanitizeText) {
      throw new Error("expected Zalo Personal outbound sanitizeText hook");
    }
    const sanitize = (text: string) => sanitizeText({ text, payload: { text } });
    const fenced = ["```xml", '<tool_call>{"name":"exec"}</tool_call>', "```"].join("\n");

    expect(sanitize("Done.\n⚠️ 🛠️ `search repos (agent)` failed")).toBe("Done.");
    expect(sanitize('<tool_call>{"name":"exec"}</tool_call>Message sent.')).toBe("Message sent.");
    expect(sanitize("The personal message was delivered.")).toBe(
      "The personal message was delivered.",
    );
    expect(sanitize(fenced)).toBe(fenced);
    expect(sanitize("⚠️ 🛠️ `search repos (agent)` failed")).toBe("");
  });
});

describe("zalouser outbound chunking", () => {
  it("chunks outbound text without requiring Zalouser runtime initialization", () => {
    const chunker = zalouserOutboundAdapter.chunker;
    if (!chunker) {
      throw new Error("zalouser outbound.chunker unavailable");
    }

    expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
  });
});

describe("zalouser channel policies", () => {
  beforeEach(() => {
    mockSendReaction.mockClear();
    mockSendReaction.mockResolvedValue({ ok: true } as never);
  });

  it("normalizes dm allowlist entries after trimming channel prefixes", () => {
    const resolveDmPolicy = zalouserSecurityAdapter.resolveDmPolicy;
    if (!resolveDmPolicy) {
      throw new Error("resolveDmPolicy unavailable");
    }

    const cfg = {
      channels: {
        zalouser: {
          dmPolicy: "allowlist",
          allowFrom: ["  zlu:123456  "],
        },
      },
    } as never;
    const account = {
      accountId: "default",
      enabled: true,
      authenticated: false,
      profile: "default",
      config: {
        dmPolicy: "allowlist",
        allowFrom: ["  zlu:123456  "],
      },
    } as never;

    const result = resolveDmPolicy({ cfg, account });
    if (!result) {
      throw new Error("zalouser resolveDmPolicy returned null");
    }

    expect(result.policy).toBe("allowlist");
    expect(result.allowFrom).toEqual(["  zlu:123456  "]);
    expect(result.normalizeEntry?.("  zlu:123456  ")).toBe("123456");
  });

  it("normalizes pairing allowlist entries after trimming channel prefixes", () => {
    const normalizeAllowEntry = requireZalouserPairingNormalizer();

    expect(normalizeAllowEntry("  zlu:123456  ")).toBe("123456");
    expect(normalizeAllowEntry("  zalouser:654321  ")).toBe("654321");
  });

  it("resolves requireMention from group config", () => {
    const resolveRequireMention = requireZalouserResolveRequireMention();
    const requireMention = resolveRequireMention({
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "123": { requireMention: false },
            },
          },
        },
      },
      accountId: "default",
      groupId: "123",
      groupChannel: "123",
    });
    expect(requireMention).toBe(false);
  });

  it("falls back to wildcard group policy", () => {
    const policy = resolveGroupToolPolicy({ "*": { tools: { deny: ["system.run"] } } }, "missing");
    expect(policy).toEqual({ deny: ["system.run"] });
  });

  it("handles react action", async () => {
    const actions = zalouserMessageActions;
    expect(
      actions?.describeMessageTool?.({ cfg: { channels: { zalouser: { enabled: true } } } })
        ?.actions,
    ).toEqual(["react"]);
    const result = await actions?.handleAction?.({
      channel: "zalouser",
      action: "react",
      params: {
        threadId: "123456",
        messageId: "111",
        cliMsgId: "222",
        emoji: "👍",
      },
      cfg: {
        channels: {
          zalouser: {
            enabled: true,
            profile: "default",
          },
        },
      },
    });
    expect(mockSendReaction).toHaveBeenCalledWith({
      profile: "default",
      threadId: "123456",
      isGroup: false,
      msgId: "111",
      cliMsgId: "222",
      emoji: "👍",
      remove: false,
    });
    expect(result).toEqual({
      content: [{ type: "text", text: "Reacted 👍 on 111" }],
      details: {
        messageId: "111",
        cliMsgId: "222",
        threadId: "123456",
      },
    });
  });

  it.each([
    {
      name: "prefixed direct target inside an ambient group",
      params: { chatId: "zlu:user:user-456" },
      threadId: "user-456",
      isGroup: false,
    },
    {
      name: "explicit direct override for a group target",
      params: { to: "group:override-789", isGroup: false },
      threadId: "override-789",
      isGroup: false,
    },
    {
      name: "ambient group without a target prefix",
      params: {},
      threadId: "ambient-group",
      isGroup: true,
    },
  ])("routes $name reactions through the canonical target owner", async (testCase) => {
    const result = await zalouserMessageActions.handleAction?.({
      channel: "zalouser",
      action: "react",
      params: {
        messageId: "111",
        cliMsgId: "222",
        emoji: "👍",
        ...testCase.params,
      },
      cfg: { channels: { zalouser: { enabled: true, profile: "default" } } },
      toolContext: {
        currentChannelProvider: "zalouser",
        currentChannelId: "ambient-group",
        currentChatType: "group",
      },
    });

    expect(mockSendReaction).toHaveBeenCalledWith({
      profile: "default",
      threadId: testCase.threadId,
      isGroup: testCase.isGroup,
      msgId: "111",
      cliMsgId: "222",
      emoji: "👍",
      remove: false,
    });
    expect(result?.details).toEqual({
      messageId: "111",
      cliMsgId: "222",
      threadId: testCase.threadId,
    });
  });

  it("does not borrow group routing from another channel with the same conversation id", async () => {
    await zalouserMessageActions.handleAction?.({
      channel: "zalouser",
      action: "react",
      params: {
        to: "shared-conversation",
        messageId: "111",
        cliMsgId: "222",
        emoji: "👍",
      },
      cfg: { channels: { zalouser: { enabled: true, profile: "default" } } },
      toolContext: {
        currentChannelProvider: "slack",
        currentChannelId: "shared-conversation",
        currentChatType: "group",
      },
    });

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "shared-conversation", isGroup: false }),
    );
  });

  it("honors the selected Zalouser account during discovery", () => {
    const actions = zalouserMessageActions;
    const cfg = {
      channels: {
        zalouser: {
          enabled: true,
          profile: "default",
          accounts: {
            default: {
              enabled: false,
              profile: "default",
            },
            work: {
              enabled: true,
              profile: "work",
            },
          },
        },
      },
    };

    expect(actions?.describeMessageTool?.({ cfg, accountId: "default" })).toBeNull();
    expect(actions?.describeMessageTool?.({ cfg, accountId: "work" })?.actions).toEqual(["react"]);
  });
});

describe("zalouser account resolution", () => {
  beforeEach(() => {
    listZaloFriendsMatchingMock.mockReset();
    startZaloQrLoginMock.mockReset();
    waitForZaloQrLoginMock.mockReset();
  });

  it("uses the configured default account for omitted target lookup", async () => {
    const resolveTargets = zalouserResolverAdapter.resolveTargets;
    if (!resolveTargets) {
      throw new Error("zalouser resolver.resolveTargets unavailable");
    }

    listZaloFriendsMatchingMock.mockResolvedValue([
      { userId: "42", displayName: "Work User" } as never,
    ]);

    const result = await resolveTargets({
      cfg: {
        channels: {
          zalouser: {
            defaultAccount: "work",
            accounts: {
              work: {
                profile: "work-profile",
              },
            },
          },
        },
      } as never,
      inputs: ["Work User"],
      kind: "user",
      runtime: createNonExitingRuntimeEnv(),
    });

    expect(listZaloFriendsMatchingMock).toHaveBeenCalledWith("work-profile", "Work User");
    expect(result).toEqual([
      {
        input: "Work User",
        resolved: true,
        id: "42",
        name: "Work User",
        note: undefined,
      },
    ]);
  });

  it("uses the configured default account for omitted qr login", async () => {
    const login = zalouserAuthAdapter.login;
    if (!login) {
      throw new Error("zalouser auth.login unavailable");
    }

    startZaloQrLoginMock.mockResolvedValue({
      message: "qr ready",
      qrDataUrl: "data:image/png;base64,abc",
    } as never);
    waitForZaloQrLoginMock.mockResolvedValue({
      connected: true,
      userId: "u-1",
      displayName: "Work User",
    } as never);

    const runtime = createNonExitingRuntimeEnv();

    await login({
      cfg: {
        channels: {
          zalouser: {
            defaultAccount: "work",
            accounts: {
              work: {
                profile: "work-profile",
              },
            },
          },
        },
      } as never,
      runtime,
    });

    expect(startZaloQrLoginMock).toHaveBeenCalledWith({
      profile: "work-profile",
      timeoutMs: 35_000,
    });
    expect(waitForZaloQrLoginMock).toHaveBeenCalledWith({
      profile: "work-profile",
      timeoutMs: 180_000,
    });
  });
});

describe("zalouserPlugin pairing.notifyApproval", () => {
  const pairingCfg = {
    channels: {
      zalouser: {
        defaultAccount: "alpha",
        accounts: {
          alpha: { profile: "alpha-profile" },
          beta: { profile: "beta-profile" },
        },
      },
    },
  };

  beforeEach(() => {
    checkZaloAuthenticatedMock.mockClear();
    checkZaloAuthenticatedMock.mockResolvedValue(true);
    mockSendMessage.mockClear();
  });

  it("sends the approval from the approved account", async () => {
    const notifyApproval = zalouserPlugin.pairing?.notifyApproval;
    if (!notifyApproval) {
      throw new Error("zalouser pairing.notifyApproval unavailable");
    }

    await notifyApproval({
      cfg: pairingCfg,
      id: "paired-user",
      accountId: "beta",
    });

    expect(checkZaloAuthenticatedMock).toHaveBeenCalledTimes(1);
    expect(checkZaloAuthenticatedMock.mock.calls[0]?.[0]).toBe("beta-profile");
    expect(mockSendMessage).toHaveBeenCalledExactlyOnceWith(
      "paired-user",
      expect.any(String),
      expect.objectContaining({ profile: "beta-profile" }),
    );
  });
});

describe("zalouserPlugin messaging target normalization", () => {
  it("normalizes user/group aliases to canonical targets", () => {
    const normalize = zalouserPlugin.messaging?.normalizeTarget;
    if (!normalize) {
      throw new Error("normalizeTarget unavailable");
    }
    expect(normalize("zlu:g:30003")).toBe("group:30003");
    expect(normalize("zalouser:u:20002")).toBe("user:20002");
    expect(normalize("zlu:g-30003")).toBe("group:g-30003");
    expect(normalize("zalouser:u-20002")).toBe("user:u-20002");
    expect(normalize("20002")).toBe("20002");
  });

  it("treats canonical and provider-native user/group targets as ids", () => {
    const looksLikeId = zalouserPlugin.messaging?.targetResolver?.looksLikeId;
    if (!looksLikeId) {
      throw new Error("looksLikeId unavailable");
    }
    expect(looksLikeId("user:20002")).toBe(true);
    expect(looksLikeId("group:30003")).toBe(true);
    expect(looksLikeId("g-30003")).toBe(true);
    expect(looksLikeId("u-20002")).toBe(true);
    expect(looksLikeId("Alice Nguyen")).toBe(false);
  });
});

describe("zalouser directory group members", () => {
  it.each([
    ["group:1471383327500481391", "1471383327500481391"],
    ["1471383327500481391", "1471383327500481391"],
  ])("resolves directory group %s to %s", async (groupId, expectedId) => {
    const listZaloGroupMembers = vi.fn(async () => []);
    await listZalouserDirectoryGroupMembers(
      { cfg: {}, accountId: "default", groupId },
      { listZaloGroupMembers },
    );
    expect(listZaloGroupMembers).toHaveBeenLastCalledWith("default", expectedId);
  });
});

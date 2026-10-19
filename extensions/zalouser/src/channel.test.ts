import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createNonExitingRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  checkZaloAuthenticatedMock,
  listZaloFriendsMatchingMock,
  sendZaloReactionMock,
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

it("distinguishes users from groups", () => {
  expect(zalouserMessagingAdapter.inferTargetChatType({ to: "user:123" })).toBe("direct");
  expect(zalouserMessagingAdapter.inferTargetChatType({ to: "group:456" })).toBe("group");
});

import { createZalouserSendReceipt } from "./send-receipt.js";
import { sendMessageZalouser } from "./send.js";
import { listZaloGroupMembers } from "./zalo-js.js";

vi.mock("./qr-temp-file.js", () => ({
  writeQrDataUrlToTempFile: vi.fn(async () => null),
}));

vi.mock("./send.js", async () => {
  const actual = (await vi.importActual("./send.js")) as Record<string, unknown>;
  return {
    ...actual,
    sendMessageZalouser: vi.fn(async () => ({
      messageId: "mid-1",
      receipt: createZalouserSendReceipt({ messageId: "mid-1" }),
    })),
  };
});

const mockSendMessage = vi.mocked(sendMessageZalouser);
const mockSendReaction = sendZaloReactionMock;

function required<T>(value: T | null | undefined): T {
  if (value == null) {
    throw new Error("Expected Zalouser adapter hook");
  }
  return value;
}

function config(
  zalouser: NonNullable<NonNullable<OpenClawConfig["channels"]>["zalouser"]>,
): OpenClawConfig {
  return { channels: { zalouser } };
}

const workConfig = config({
  defaultAccount: "work",
  accounts: { work: { profile: "work-profile" } },
});

function resolveGroupToolPolicy(
  groups: Record<string, { tools: { allow?: string[]; deny?: string[] } }>,
  groupId: string,
) {
  return zalouserGroupsAdapter.resolveToolPolicy({
    cfg: config({ groups }),
    accountId: "default",
    groupId,
    groupChannel: groupId,
  });
}

function react(
  params: Parameters<NonNullable<typeof zalouserMessageActions.handleAction>>[0]["params"],
  toolContext?: Parameters<
    NonNullable<typeof zalouserMessageActions.handleAction>
  >[0]["toolContext"],
) {
  return required(zalouserMessageActions.handleAction)({
    channel: "zalouser",
    action: "react",
    cfg: config({ enabled: true, profile: "default" }),
    params: { messageId: "111", cliMsgId: "222", emoji: "👍", ...params },
    toolContext,
  });
}

it("removes internal tool text while preserving user-visible examples", () => {
  const sanitizeText = required(zalouserOutboundAdapter.sanitizeText);
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

it("chunks outbound text without requiring Zalouser runtime initialization", () => {
  const chunker = required(zalouserOutboundAdapter.chunker);

  expect(chunker("alpha beta", 5)).toEqual(["alpha", "beta"]);
});

describe("zalouser channel policies", () => {
  beforeEach(() => {
    mockSendReaction.mockClear();
    mockSendReaction.mockResolvedValue(undefined);
  });

  it("normalizes dm allowlist entries after trimming channel prefixes", () => {
    const resolveDmPolicy = required(zalouserSecurityAdapter.resolveDmPolicy);

    const cfg = config({ dmPolicy: "allowlist", allowFrom: ["  zlu:123456  "] });
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

    const result = required(resolveDmPolicy({ cfg, account }));

    expect(result).toMatchObject({ policy: "allowlist", allowFrom: ["  zlu:123456  "] });
    expect(result.normalizeEntry?.("  zlu:123456  ")).toBe("123456");
  });

  it("normalizes pairing allowlist entries after trimming channel prefixes", () => {
    const normalizeAllowEntry = required(zalouserPairingTextAdapter.normalizeAllowEntry);

    expect(normalizeAllowEntry("  zlu:123456  ")).toBe("123456");
    expect(normalizeAllowEntry("  zalouser:654321  ")).toBe("654321");
  });

  it("resolves requireMention from group config", () => {
    const resolveRequireMention = zalouserGroupsAdapter.resolveRequireMention;
    const requireMention = resolveRequireMention({
      cfg: config({ groups: { "123": { requireMention: false } } }),
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
    const result = await react({ threadId: "123456" });
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
    const result = await react(testCase.params, {
      currentChannelProvider: "zalouser",
      currentChannelId: "ambient-group",
      currentChatType: "group",
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
    await react(
      { to: "shared-conversation" },
      {
        currentChannelProvider: "slack",
        currentChannelId: "shared-conversation",
        currentChatType: "group",
      },
    );

    expect(mockSendReaction).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "shared-conversation", isGroup: false }),
    );
  });

  it("honors the selected Zalouser account during discovery", () => {
    const actions = zalouserMessageActions;
    const cfg = config({
      enabled: true,
      profile: "default",
      accounts: {
        default: { enabled: false, profile: "default" },
        work: { enabled: true, profile: "work" },
      },
    });

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
    const resolveTargets = required(zalouserResolverAdapter.resolveTargets);

    listZaloFriendsMatchingMock.mockResolvedValue([
      { userId: "42", displayName: "Work User" } as never,
    ]);

    const result = await resolveTargets({
      cfg: workConfig,
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
    const login = required(zalouserAuthAdapter.login);

    startZaloQrLoginMock.mockResolvedValue({
      message: "qr ready",
      qrDataUrl: "data:image/png;base64,abc",
    } as never);
    waitForZaloQrLoginMock.mockResolvedValue({
      connected: true,
      userId: "u-1",
      displayName: "Work User",
    } as never);

    await login({
      cfg: workConfig,
      runtime: createNonExitingRuntimeEnv(),
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

it("sends the approval from the approved account", async () => {
  const pairingCfg = config({
    defaultAccount: "alpha",
    accounts: { alpha: { profile: "alpha-profile" }, beta: { profile: "beta-profile" } },
  });
  checkZaloAuthenticatedMock.mockClear();
  checkZaloAuthenticatedMock.mockResolvedValue(true);
  mockSendMessage.mockClear();
  const notifyApproval = required(zalouserPlugin.pairing?.notifyApproval);

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

describe("zalouserPlugin messaging target normalization", () => {
  it("normalizes user/group aliases to canonical targets", () => {
    const normalize = required(zalouserPlugin.messaging?.normalizeTarget);
    expect(normalize("zlu:g:30003")).toBe("group:30003");
    expect(normalize("zalouser:u:20002")).toBe("user:20002");
    expect(normalize("zlu:g-30003")).toBe("group:g-30003");
    expect(normalize("zalouser:u-20002")).toBe("user:u-20002");
    expect(normalize("20002")).toBe("20002");
  });

  it("treats canonical and provider-native user/group targets as ids", () => {
    const looksLikeId = required(zalouserPlugin.messaging?.targetResolver?.looksLikeId);
    expect(looksLikeId("user:20002")).toBe(true);
    expect(looksLikeId("group:30003")).toBe(true);
    expect(looksLikeId("g-30003")).toBe(true);
    expect(looksLikeId("u-20002")).toBe(true);
    expect(looksLikeId("Alice Nguyen")).toBe(false);
  });
});

it.each([
  ["group:1471383327500481391", "1471383327500481391"],
  ["1471383327500481391", "1471383327500481391"],
])("resolves directory group %s to %s", async (groupId, expectedId) => {
  vi.mocked(listZaloGroupMembers).mockResolvedValueOnce([]);
  await required(zalouserPlugin.directory?.listGroupMembers)({
    cfg: {},
    accountId: "default",
    groupId,
    runtime: createNonExitingRuntimeEnv(),
  });
  expect(listZaloGroupMembers).toHaveBeenLastCalledWith("default", expectedId);
});

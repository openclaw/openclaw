import { beforeEach, describe, expect, it, vi } from "vitest";
import "./zalo-js.test-mocks.js";
import { zalouserPlugin } from "./channel.js";
import { setZalouserRuntime } from "./runtime.js";
import { sendMessageZalouser, sendReactionZalouser } from "./send.js";

vi.mock("./send.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendMessageZalouser: vi.fn(async () => ({ ok: true, messageId: "mid-1" })),
    sendReactionZalouser: vi.fn(async () => ({ ok: true })),
  };
});

const mockSendMessage = vi.mocked(sendMessageZalouser);
const mockSendReaction = vi.mocked(sendReactionZalouser);

function getResolveToolPolicy() {
  const resolveToolPolicy = zalouserPlugin.groups?.resolveToolPolicy;
  expect(resolveToolPolicy).toBeTypeOf("function");
  if (!resolveToolPolicy) {
    throw new Error("resolveToolPolicy unavailable");
  }
  return resolveToolPolicy;
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
  beforeEach(() => {
    mockSendMessage.mockClear();
    setZalouserRuntime({
      channel: {
        text: {
          resolveChunkMode: vi.fn(() => "newline"),
          resolveTextChunkLimit: vi.fn(() => 10),
        },
      },
    } as never);
  });

  it("passes markdown chunk settings through sendText", async () => {
    const sendText = zalouserPlugin.outbound?.sendText;
    expect(sendText).toBeTypeOf("function");
    if (!sendText) {
      return;
    }

    const result = await sendText({
      cfg: { channels: { zalouser: { enabled: true } } } as never,
      to: "group:123456",
      text: "hello world\nthis is a test",
      accountId: "default",
    } as never);

    expect(mockSendMessage).toHaveBeenCalledWith(
      "123456",
      "hello world\nthis is a test",
      expect.objectContaining({
        profile: "default",
        isGroup: true,
        textMode: "markdown",
        textChunkMode: "newline",
        textChunkLimit: 10,
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        channel: "zalouser",
        messageId: "mid-1",
        ok: true,
      }),
    );
  });
});

describe("zalouser channel policies", () => {
  beforeEach(() => {
    mockSendReaction.mockClear();
    mockSendReaction.mockResolvedValue({ ok: true });
  });

  it("resolves requireMention from group config", () => {
    const resolveRequireMention = zalouserPlugin.groups?.resolveRequireMention;
    expect(resolveRequireMention).toBeTypeOf("function");
    if (!resolveRequireMention) {
      return;
    }
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

  it("resolves group tool policy by explicit group id", () => {
    const policy = resolveGroupToolPolicy({ "123": { tools: { allow: ["search"] } } }, "123");
    expect(policy).toEqual({ allow: ["search"] });
  });

  it("falls back to wildcard group policy", () => {
    const policy = resolveGroupToolPolicy({ "*": { tools: { deny: ["system.run"] } } }, "missing");
    expect(policy).toEqual({ deny: ["system.run"] });
  });

  it("handles react action", async () => {
    const actions = zalouserPlugin.actions;
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
    expect(result).toBeDefined();
  });
});

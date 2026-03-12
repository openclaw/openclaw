import { beforeEach, describe, expect, it, vi } from "vitest";
import { chunkMarkdownText } from "../../../src/auto-reply/chunk.js";
import { zalouserPlugin } from "./channel.js";
import { setZalouserRuntime } from "./runtime.js";
import { sendReactionZalouser } from "./send.js";

vi.mock("./send.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    sendReactionZalouser: vi.fn(async () => ({ ok: true })),
  };
});

const mockSendReaction = vi.mocked(sendReactionZalouser);

describe("zalouser outbound chunker", () => {
  beforeEach(() => {
    setZalouserRuntime({
      channel: {
        text: {
          chunkMarkdownText,
        },
      },
    } as never);
  });

  it("chunks without empty strings and respects limit", () => {
    const chunker = zalouserPlugin.outbound?.chunker;
    expect(chunker).toBeTypeOf("function");
    if (!chunker) {
      return;
    }

    const limit = 10;
    const chunks = chunker("hello world\nthis is a test", limit);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length > 0)).toBe(true);
    expect(chunks.every((c) => c.length <= limit)).toBe(true);
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
    const resolveToolPolicy = zalouserPlugin.groups?.resolveToolPolicy;
    expect(resolveToolPolicy).toBeTypeOf("function");
    if (!resolveToolPolicy) {
      return;
    }
    const policy = resolveToolPolicy({
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "123": { tools: { allow: ["search"] } },
            },
          },
        },
      },
      accountId: "default",
      groupId: "123",
      groupChannel: "123",
    });
    expect(policy).toEqual({ allow: ["search"] });
  });

  it("falls back to wildcard group policy", () => {
    const resolveToolPolicy = zalouserPlugin.groups?.resolveToolPolicy;
    expect(resolveToolPolicy).toBeTypeOf("function");
    if (!resolveToolPolicy) {
      return;
    }
    const policy = resolveToolPolicy({
      cfg: {
        channels: {
          zalouser: {
            groups: {
              "*": { tools: { deny: ["system.run"] } },
            },
          },
        },
      },
      accountId: "default",
      groupId: "missing",
      groupChannel: "missing",
    });
    expect(policy).toEqual({ deny: ["system.run"] });
  });

  it("handles react action", async () => {
    const actions = zalouserPlugin.actions;
    expect(actions?.listActions?.({ cfg: { channels: { zalouser: { enabled: true } } } })).toEqual([
      "react",
    ]);
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

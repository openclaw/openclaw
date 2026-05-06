import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { dispatchInboundMessageMock, dispatchResult, sendReactionSignalMock, sendTypingMock } =
  vi.hoisted(() => {
    const result = { queuedFinal: true };
    return {
      dispatchInboundMessageMock: vi.fn(
        async (params: {
          ctx: MsgContext;
          replyOptions?: {
            onReplyStart?: () => void | Promise<void>;
            onToolStart?: (payload: { name?: string }) => void | Promise<void>;
          };
        }) => {
          await params.replyOptions?.onReplyStart?.();
          await params.replyOptions?.onToolStart?.({ name: "read_file" });
          return { ...result, counts: { tool: result.queuedFinal ? 1 : 0, block: 0, final: 0 } };
        },
      ),
      dispatchResult: result,
      sendReactionSignalMock: vi.fn().mockResolvedValue({ ok: true }),
      sendTypingMock: vi.fn().mockResolvedValue(true),
    };
  });

vi.mock("../send-reactions.js", () => ({
  removeReactionSignal: vi.fn(),
  sendReactionSignal: sendReactionSignalMock,
}));

vi.mock("../send.js", () => ({
  sendMessageSignal: vi.fn(),
  sendReadReceiptSignal: vi.fn().mockResolvedValue(true),
  sendTypingSignal: sendTypingMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/reply-runtime")>(
    "openclaw/plugin-sdk/reply-runtime",
  );
  return {
    ...actual,
    dispatchInboundMessage: dispatchInboundMessageMock,
  };
});

const [
  { createBaseSignalEventHandlerDeps, createSignalReceiveEvent },
  { createSignalEventHandler },
] = await Promise.all([import("./event-handler.test-harness.js"), import("./event-handler.js")]);

function createStatusReactionConfig(
  overrides: {
    ackReactionScope?: NonNullable<OpenClawConfig["messages"]>["ackReactionScope"];
    requireMention?: boolean;
  } = {},
): OpenClawConfig {
  return {
    messages: {
      ackReaction: "👀",
      ackReactionScope: overrides.ackReactionScope ?? "all",
      groupChat: {
        mentionPatterns: ["@bot"],
      },
      inbound: { debounceMs: 0 },
      statusReactions: {
        enabled: true,
        emojis: {
          done: "✅",
        },
        timing: {
          debounceMs: 60_000,
          stallSoftMs: 600_000,
          stallHardMs: 600_000,
        },
      },
    },
    channels: {
      signal: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groups: {
          "*": {
            requireMention: overrides.requireMention ?? false,
          },
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("signal status reactions", () => {
  beforeEach(() => {
    dispatchResult.queuedFinal = true;
    dispatchInboundMessageMock.mockClear();
    sendReactionSignalMock.mockClear();
    sendTypingMock.mockClear();
  });

  it("reacts to direct inbound messages with queued and done status", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createStatusReactionConfig(),
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550002222",
        timestamp: 1700000001234,
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(sendReactionSignalMock).toHaveBeenCalledTimes(2);
    });
    expect(sendReactionSignalMock).toHaveBeenNthCalledWith(
      1,
      "+15550002222",
      1700000001234,
      "👀",
      expect.objectContaining({
        accountId: "default",
        targetAuthor: "+15550002222",
      }),
    );
    expect(sendReactionSignalMock).toHaveBeenNthCalledWith(
      2,
      "+15550002222",
      1700000001234,
      "✅",
      expect.objectContaining({
        accountId: "default",
        targetAuthor: "+15550002222",
      }),
    );
  });

  it("routes group status reactions through groupId and targetAuthor", async () => {
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createStatusReactionConfig({
          ackReactionScope: "group-mentions",
          requireMention: true,
        }),
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550003333",
        timestamp: 1700000005678,
        dataMessage: {
          message: "hello @bot",
          attachments: [],
          groupInfo: { groupId: "group-1", groupName: "Test Group" },
        },
      }),
    );

    await vi.waitFor(() => {
      expect(sendReactionSignalMock).toHaveBeenCalledTimes(2);
    });
    expect(sendReactionSignalMock).toHaveBeenNthCalledWith(
      1,
      "",
      1700000005678,
      "👀",
      expect.objectContaining({
        groupId: "group-1",
        targetAuthor: "+15550003333",
      }),
    );
    expect(sendReactionSignalMock).toHaveBeenNthCalledWith(
      2,
      "",
      1700000005678,
      "✅",
      expect.objectContaining({
        groupId: "group-1",
        targetAuthor: "+15550003333",
      }),
    );
  });

  it("restores the initial reaction instead of done when no final reply is queued", async () => {
    dispatchResult.queuedFinal = false;
    const handler = createSignalEventHandler(
      createBaseSignalEventHandlerDeps({
        cfg: createStatusReactionConfig(),
        historyLimit: 0,
      }),
    );

    await handler(
      createSignalReceiveEvent({
        sourceNumber: "+15550004444",
        timestamp: 1700000009012,
        dataMessage: {
          message: "hello",
          attachments: [],
        },
      }),
    );

    await vi.waitFor(() => {
      expect(sendReactionSignalMock).toHaveBeenCalled();
    });
    await Promise.resolve();
    const emojis = sendReactionSignalMock.mock.calls.map((call) => call[2]);
    expect(emojis).toContain("👀");
    expect(emojis).not.toContain("✅");
  });
});

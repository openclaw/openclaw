import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { linePlugin } from "./channel.js";
import { setLineRuntime } from "./runtime.js";

type LineRuntimeMocks = {
  pushMessageLine: ReturnType<typeof vi.fn>;
  pushMessagesLine: ReturnType<typeof vi.fn>;
  pushFlexMessage: ReturnType<typeof vi.fn>;
  pushTemplateMessage: ReturnType<typeof vi.fn>;
  pushLocationMessage: ReturnType<typeof vi.fn>;
  pushTextMessageWithQuickReplies: ReturnType<typeof vi.fn>;
  createQuickReplyItems: ReturnType<typeof vi.fn>;
  buildTemplateMessageFromPayload: ReturnType<typeof vi.fn>;
  sendMessageLine: ReturnType<typeof vi.fn>;
  chunkMarkdownText: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
  resolveTextChunkLimit: ReturnType<typeof vi.fn>;
};

function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const pushMessageLine = vi.fn(async () => ({ messageId: "m-text", chatId: "c1" }));
  const pushMessagesLine = vi.fn(async () => ({ messageId: "m-batch", chatId: "c1" }));
  const pushFlexMessage = vi.fn(async () => ({ messageId: "m-flex", chatId: "c1" }));
  const pushTemplateMessage = vi.fn(async () => ({ messageId: "m-template", chatId: "c1" }));
  const pushLocationMessage = vi.fn(async () => ({ messageId: "m-loc", chatId: "c1" }));
  const pushTextMessageWithQuickReplies = vi.fn(async () => ({
    messageId: "m-quick",
    chatId: "c1",
  }));
  const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
  const buildTemplateMessageFromPayload = vi.fn(() => ({ type: "buttons" }));
  const sendMessageLine = vi.fn(async () => ({ messageId: "m-media", chatId: "c1" }));
  const chunkMarkdownText = vi.fn((text: string) => [text]);
  const resolveTextChunkLimit = vi.fn(() => 123);
  const resolveLineAccount = vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const resolved = accountId ?? "default";
      const lineConfig = (cfg.channels?.line ?? {}) as {
        accounts?: Record<string, Record<string, unknown>>;
      };
      const accountConfig = resolved !== "default" ? (lineConfig.accounts?.[resolved] ?? {}) : {};
      return {
        accountId: resolved,
        config: { ...lineConfig, ...accountConfig },
      };
    },
  );

  const runtime = {
    channel: {
      line: {
        pushMessageLine,
        pushMessagesLine,
        pushFlexMessage,
        pushTemplateMessage,
        pushLocationMessage,
        pushTextMessageWithQuickReplies,
        createQuickReplyItems,
        buildTemplateMessageFromPayload,
        sendMessageLine,
        resolveLineAccount,
      },
      text: {
        chunkMarkdownText,
        resolveTextChunkLimit,
      },
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    mocks: {
      pushMessageLine,
      pushMessagesLine,
      pushFlexMessage,
      pushTemplateMessage,
      pushLocationMessage,
      pushTextMessageWithQuickReplies,
      createQuickReplyItems,
      buildTemplateMessageFromPayload,
      sendMessageLine,
      chunkMarkdownText,
      resolveLineAccount,
      resolveTextChunkLimit,
    },
  };
}

describe("linePlugin outbound.sendPayload", () => {
  it("sends flex message without dropping text", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "Now playing:",
      channelData: {
        line: {
          flexMessage: {
            altText: "Now playing",
            contents: { type: "bubble" },
          },
        },
      },
    };

    await linePlugin.outbound!.sendPayload!({
      to: "line:group:1",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.pushFlexMessage).toHaveBeenCalledTimes(1);
    expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:group:1", "Now playing:", {
      verbose: false,
      accountId: "default",
    });
  });

  it("sends template message without dropping text", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "Choose one:",
      channelData: {
        line: {
          templateMessage: {
            type: "confirm",
            text: "Continue?",
            confirmLabel: "Yes",
            confirmData: "yes",
            cancelLabel: "No",
            cancelData: "no",
          },
        },
      },
    };

    await linePlugin.outbound!.sendPayload!({
      to: "line:user:1",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.buildTemplateMessageFromPayload).toHaveBeenCalledTimes(1);
    expect(mocks.pushTemplateMessage).toHaveBeenCalledTimes(1);
    expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:user:1", "Choose one:", {
      verbose: false,
      accountId: "default",
    });
  });

  it("attaches quick replies when no text chunks are present", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          quickReplies: ["One", "Two"],
          flexMessage: {
            altText: "Card",
            contents: { type: "bubble" },
          },
        },
      },
    };

    await linePlugin.outbound!.sendPayload!({
      to: "line:user:2",
      text: "",
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.pushFlexMessage).not.toHaveBeenCalled();
    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:user:2",
      [
        {
          type: "flex",
          altText: "Card",
          contents: { type: "bubble" },
          quickReply: { items: ["One", "Two"] },
        },
      ],
      { verbose: false, accountId: "default" },
    );
    expect(mocks.createQuickReplyItems).toHaveBeenCalledWith(["One", "Two"]);
  });

  it("sends media before quick-reply text so buttons stay visible", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "Hello",
      mediaUrl: "https://example.com/img.jpg",
      channelData: {
        line: {
          quickReplies: ["One", "Two"],
        },
      },
    };

    await linePlugin.outbound!.sendPayload!({
      to: "line:user:3",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.sendMessageLine).toHaveBeenCalledWith("line:user:3", "", {
      verbose: false,
      mediaUrl: "https://example.com/img.jpg",
      accountId: "default",
    });
    expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledWith(
      "line:user:3",
      "Hello",
      ["One", "Two"],
      { verbose: false, accountId: "default" },
    );
    const mediaOrder = mocks.sendMessageLine.mock.invocationCallOrder[0];
    const quickReplyOrder = mocks.pushTextMessageWithQuickReplies.mock.invocationCallOrder[0];
    expect(mediaOrder).toBeLessThan(quickReplyOrder);
  });

  it("uses configured text chunk limit for payloads", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: { textChunkLimit: 123 } } } as OpenClawConfig;

    const payload = {
      text: "Hello world",
      channelData: {
        line: {
          flexMessage: {
            altText: "Card",
            contents: { type: "bubble" },
          },
        },
      },
    };

    await linePlugin.outbound!.sendPayload!({
      to: "line:user:3",
      text: payload.text,
      payload,
      accountId: "primary",
      cfg,
    });

    expect(mocks.resolveTextChunkLimit).toHaveBeenCalledWith(cfg, "line", "primary", {
      fallbackLimit: 5000,
    });
    expect(mocks.chunkMarkdownText).toHaveBeenCalledWith("Hello world", 123);
  });

  it("sends processed flex messages (tables) before template message", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    // Markdown table triggers processLineMessage to produce flexMessages
    const tableText = "| Col1 | Col2 |\n|------|------|\n| A    | B    |";
    const payload = {
      text: tableText,
      channelData: {
        line: {
          templateMessage: {
            type: "confirm",
            text: "Next page?",
            confirmLabel: "Yes",
            confirmData: "yes",
            cancelLabel: "No",
            cancelData: "no",
          },
        },
      },
    };

    await linePlugin.outbound!.sendPayload!({
      to: "line:user:4",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    // Both should have been called
    expect(mocks.pushFlexMessage).toHaveBeenCalled();
    expect(mocks.pushTemplateMessage).toHaveBeenCalled();

    // Flex (table detail) must be sent BEFORE template (buttons/pagination)
    const flexOrder = mocks.pushFlexMessage.mock.invocationCallOrder[0];
    const templateOrder = mocks.pushTemplateMessage.mock.invocationCallOrder[0];
    expect(flexOrder).toBeLessThan(templateOrder);
  });

  it("orders processed flex before template in quick-reply batch", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    // Table-only text with quick replies triggers the inline quick-reply batch path
    const tableText = "| Col1 | Col2 |\n|------|------|\n| A    | B    |";
    const payload = {
      text: tableText,
      channelData: {
        line: {
          quickReplies: ["Next", "Back"],
          templateMessage: {
            type: "confirm",
            text: "Navigate?",
            confirmLabel: "Next",
            confirmData: "next",
            cancelLabel: "Back",
            cancelData: "back",
          },
        },
      },
    };

    await linePlugin.outbound!.sendPayload!({
      to: "line:user:5",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    // In the quick-reply batch path, messages are batched via pushMessagesLine
    expect(mocks.pushMessagesLine).toHaveBeenCalled();
    const batchCall = mocks.pushMessagesLine.mock.calls[0];
    const messages = batchCall[1] as Array<Record<string, unknown>>;

    // Find positions of flex (table) and template (buttons) in the batch
    const flexIndex = messages.findIndex((m) => m.type === "flex");
    const templateIndex = messages.findIndex((m) => m.type === "buttons");
    expect(flexIndex).toBeGreaterThanOrEqual(0);
    expect(templateIndex).toBeGreaterThanOrEqual(0);
    expect(flexIndex).toBeLessThan(templateIndex);
  });
});

describe("linePlugin config.formatAllowFrom", () => {
  it("strips line:user: prefixes without lowercasing", () => {
    const formatted = linePlugin.config.formatAllowFrom!({
      cfg: {} as OpenClawConfig,
      allowFrom: ["line:user:UABC", "line:UDEF"],
    });
    expect(formatted).toEqual(["UABC", "UDEF"]);
  });
});

describe("linePlugin groups.resolveRequireMention", () => {
  it("uses account-level group settings when provided", () => {
    const { runtime } = createRuntime();
    setLineRuntime(runtime);

    const cfg = {
      channels: {
        line: {
          groups: {
            "*": { requireMention: false },
          },
          accounts: {
            primary: {
              groups: {
                "group-1": { requireMention: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const requireMention = linePlugin.groups!.resolveRequireMention!({
      cfg,
      accountId: "primary",
      groupId: "group-1",
    });

    expect(requireMention).toBe(true);
  });
});

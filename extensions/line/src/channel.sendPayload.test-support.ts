import { type Mock, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { createLineSendReceipt } from "./send-receipt.js";

type LineRuntimeMocks = {
  pushMessageLine: ReturnType<typeof vi.fn>;
  pushMessagesLine: Mock<typeof import("./send.js").pushMessagesLine>;
  createQuickReplyItems: ReturnType<typeof vi.fn>;
  buildTemplateMessageFromPayload: ReturnType<typeof vi.fn>;
  chunkMarkdownText: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
  resolveTextChunkLimit: ReturnType<typeof vi.fn>;
};

export type LineWireMessage = {
  type: string;
  text?: string;
  altText?: string;
  originalContentUrl?: string;
  quickReply?: unknown;
  quoteToken?: string;
};

// One payload now travels as batched provider requests, so the observable wire
// shape is the ordered message list those requests carried.
export function sentMessages(mocks: {
  pushMessagesLine: ReturnType<typeof vi.fn>;
}): LineWireMessage[] {
  return mocks.pushMessagesLine.mock.calls.flatMap((call) => call[1] as LineWireMessage[]);
}

export function createCredentialBearingHttpUrl(): string {
  const url = new URL("http://example.com/image.jpg");
  url.username = ["line", "user"].join("-");
  url.password = ["line", "fixture"].join("-");
  url.searchParams.set("auth", ["line", "query"].join("-"));
  return url.href;
}

export function lineResult(messageId: string, chatId = "c1") {
  return {
    messageId,
    chatId,
    receipt: createLineSendReceipt({ messageId, chatId, kind: "text" }),
  };
}

// LINE answers a push with one sent-message id per message object, so a double
// that returns a single id for a five-message request is a state the platform
// cannot produce — and it would hide anything that reads ids across requests.
function lineBatchResult(messageCount: number, prefix = "m-batch", chatId = "c1") {
  const messageIds = Array.from({ length: Math.max(1, messageCount) }, (_, index) =>
    index === 0 ? prefix : `${prefix}-${index + 1}`,
  );
  const messageId = messageIds[0] ?? prefix;
  return {
    messageId,
    chatId,
    receipt: createLineSendReceipt({ messageId, messageIds, chatId, kind: "text" }),
  };
}

export function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const pushMessageLine = vi.fn(async () => lineResult("m-text"));
  let batchIndex = 0;
  // Ids are unique per request as well as per message; reusing one across
  // requests would hide anything that reads them across a whole payload.
  const pushMessagesLine = vi.fn<typeof import("./send.js").pushMessagesLine>(
    async (_to, messages) => {
      batchIndex += 1;
      return lineBatchResult(
        messages.length,
        batchIndex === 1 ? "m-batch" : `m-batch-r${batchIndex}`,
      );
    },
  );
  const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
  const buildTemplateMessageFromPayload = vi.fn(() => ({
    type: "template",
    altText: "Continue?",
    template: {
      type: "confirm",
      text: "Continue?",
      actions: [
        { type: "message", label: "Yes", text: "yes" },
        { type: "message", label: "No", text: "no" },
      ],
    },
  }));
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
        createQuickReplyItems,
        buildTemplateMessageFromPayload,
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
      createQuickReplyItems,
      buildTemplateMessageFromPayload,
      chunkMarkdownText,
      resolveLineAccount,
      resolveTextChunkLimit,
    },
  };
}

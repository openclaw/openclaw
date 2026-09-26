// Line test support shares the outbound runtime harness across send suites.
import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { createLineSendReceipt } from "./send-receipt.js";

/** In-memory stand-in for the plugin blob store the durable send plan persists to. */
export type LineBlobStoreFake = Map<string, Uint8Array>;

/**
 * The real store runs SQLite in a worker whose clock a test cannot fake, and these
 * suites drive LINE's 24-hour retry-key window, so the plan namespace is simulated.
 * Only the calls the plan owner makes are modelled, with the store's TTL semantics.
 */
export function createLineBlobStoreState() {
  const blobs: LineBlobStoreFake = new Map();
  // Expiries live beside the bytes because production opens a new handle per operation.
  const expiries = new Map<string, number>();
  const isExpired = (key: string) => Date.now() >= (expiries.get(key) ?? Infinity);
  const drop = (key: string) => {
    blobs.delete(key);
    expiries.delete(key);
  };
  const openBlobStore = ({ defaultTtlMs }: { defaultTtlMs?: number }) => ({
    registerIfAbsent: async (key: string, bytes: Uint8Array) => {
      // Like the real store, an expired row still occupies its key until it is swept.
      if (blobs.has(key)) {
        return false;
      }
      blobs.set(key, bytes);
      if (defaultTtlMs !== undefined) {
        expiries.set(key, Date.now() + defaultTtlMs);
      }
      return true;
    },
    lookup: async (key: string) => {
      const bytes = isExpired(key) ? undefined : blobs.get(key);
      return bytes
        ? { key, bytes, metadata: {}, sizeBytes: bytes.byteLength, createdAt: 0 }
        : undefined;
    },
    entries: async () =>
      Array.from(blobs.keys())
        .filter((key) => !isExpired(key))
        .map((key) => ({ key })),
    delete: async (key: string) => {
      const existed = blobs.has(key);
      drop(key);
      return existed;
    },
    deleteExpired: async () => {
      const expired = Array.from(blobs.keys()).filter(isExpired);
      expired.forEach(drop);
      return expired;
    },
  });
  return { state: { openBlobStore }, blobs };
}

type LineRuntimeMocks = {
  blobs: LineBlobStoreFake;
  pushMessageLine: ReturnType<typeof vi.fn>;
  pushMessagesLine: ReturnType<typeof vi.fn>;
  createQuickReplyItems: ReturnType<typeof vi.fn>;
  buildTemplateMessageFromPayload: ReturnType<typeof vi.fn>;
  chunkMarkdownText: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
  resolveTextChunkLimit: ReturnType<typeof vi.fn>;
};

export function lineResult(messageId: string, chatId = "c1") {
  return {
    messageId,
    chatId,
    receipt: createLineSendReceipt({ messageId, chatId, kind: "text" }),
  };
}

/**
 * Every payload push now leaves through the one batch primitive, so the stand-in
 * names its receipt after what the push actually carries. Two sends that used to
 * reach different senders stay as distinguishable as they were.
 */
function stubbedLineMessageId(messages: readonly StubbedLineMessage[]): string {
  if (messages.length !== 1) {
    return "m-batch";
  }
  const [message] = messages;
  switch (message?.type) {
    case "flex":
      return "m-flex";
    case "template":
      return "m-template";
    case "location":
      return "m-loc";
    case "image":
    case "video":
    case "audio":
      return "m-media";
    default:
      return message?.quickReply === undefined ? "m-text" : "m-quick";
  }
}

/** Only the fields the receipt id is chosen by; the push carries the whole message. */
type StubbedLineMessage = { type?: string; quickReply?: unknown };

export function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const pushMessageLine = vi.fn(async () => lineResult("m-text"));
  const pushMessagesLine = vi.fn(async (_to: string, messages: StubbedLineMessage[]) =>
    lineResult(stubbedLineMessageId(messages)),
  );
  const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
  // A real built template rides the push verbatim, so the stand-in has to be one.
  const buildTemplateMessageFromPayload = vi.fn(() => ({
    type: "template",
    altText: "Choose one",
    template: { type: "buttons" },
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

  const { state, blobs } = createLineBlobStoreState();

  const runtime = {
    state,
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
      blobs,
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

// Line test support shares the outbound runtime harness across send suites.
import { vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { createLineSendReceipt } from "./send-receipt.js";

/** In-memory stand-in for the plugin blob store the durable send plan persists to. */
export type LineBlobStoreFake = Map<string, Uint8Array>;

/** Runtime state slice backed by an in-memory store, shared by the durable suites. */
export function createLineBlobStoreState(): {
  state: { openBlobStore: ReturnType<typeof createBlobStoreOpener> };
  blobs: LineBlobStoreFake;
} {
  const namespaces = new Map<string, LineBlobStoreFake>();
  const blobs: LineBlobStoreFake = new Map();
  namespaces.set("outbound-send-plans", blobs);
  return { state: { openBlobStore: createBlobStoreOpener(namespaces) }, blobs };
}

function createBlobStoreOpener(namespaces: Map<string, LineBlobStoreFake>) {
  // Expiries live beside the bytes, per namespace, because production opens a new
  // store handle for every operation: holding them on the handle would drop each
  // entry's deadline the moment the store that recorded it went out of scope.
  const namespaceExpiries = new Map<string, Map<string, number>>();
  return (options: {
    namespace: string;
    defaultTtlMs?: number;
    maxEntries?: number;
    maxBytesPerEntry?: number;
    maxBytesPerNamespace?: number;
    overflowPolicy?: "reject-new" | "evict-oldest";
  }) => {
    const blobs = namespaces.get(options.namespace) ?? new Map<string, Uint8Array>();
    namespaces.set(options.namespace, blobs);
    // The store this stands in for drops an entry once its TTL passes. Keeping
    // entries forever here would make every expiry-dependent assertion pass by
    // construction, including the window a recorded plan has to survive.
    const expiries = namespaceExpiries.get(options.namespace) ?? new Map<string, number>();
    namespaceExpiries.set(options.namespace, expiries);
    const isExpired = (key: string) => {
      const expiresAt = expiries.get(key);
      return expiresAt !== undefined && Date.now() >= expiresAt;
    };
    const drop = (key: string) => {
      blobs.delete(key);
      expiries.delete(key);
    };
    const live = (key: string) => {
      if (isExpired(key)) {
        drop(key);
      }
      return blobs.has(key);
    };
    const put = (key: string, bytes: Uint8Array, ttlMs?: number) => {
      // Production refuses a new entry once the namespace is full rather than
      // evicting one, and that refusal is what an operator actually sees. A stand-in
      // with no ceiling makes every full-namespace assertion pass by construction.
      // A part writes one row once, so within a part the row count cannot grow — but a
      // delivery has one row per part, and production charges a rewrite only its growth,
      // so both ceilings still decide whether a later part can be recorded.
      if (options.maxBytesPerEntry !== undefined && bytes.byteLength > options.maxBytesPerEntry) {
        throw new Error(
          `plugin blob entry exceeds the configured ${options.maxBytesPerEntry} byte limit`,
        );
      }
      if (
        options.overflowPolicy === "reject-new" &&
        options.maxEntries !== undefined &&
        !blobs.has(key) &&
        blobs.size >= options.maxEntries
      ) {
        throw new Error("Plugin blob namespace reached its stored row limit.");
      }
      if (options.maxBytesPerNamespace !== undefined) {
        // Same accounting as the real store: the row being replaced is credited back
        // before the new bytes are charged (plugin-blob-store.sqlite.ts).
        let namespaceBytes = 0;
        for (const stored of blobs.values()) {
          namespaceBytes += stored.byteLength;
        }
        const previousBytes = blobs.get(key)?.byteLength ?? 0;
        if (namespaceBytes - previousBytes + bytes.byteLength > options.maxBytesPerNamespace) {
          throw new Error("Plugin blob namespace reached its stored byte limit.");
        }
      }
      blobs.set(key, bytes);
      const effectiveTtlMs = ttlMs ?? options.defaultTtlMs;
      if (effectiveTtlMs === undefined) {
        expiries.delete(key);
        return;
      }
      expiries.set(key, Date.now() + effectiveTtlMs);
    };
    const info = (key: string) => ({
      key,
      metadata: {},
      sizeBytes: blobs.get(key)?.byteLength ?? 0,
      createdAt: 0,
    });
    return {
      register: async (
        key: string,
        bytes: Uint8Array,
        _metadata?: unknown,
        entryOptions?: { ttlMs?: number },
      ) => {
        put(key, bytes, entryOptions?.ttlMs);
      },
      registerIfAbsent: async (
        key: string,
        bytes: Uint8Array,
        _metadata?: unknown,
        entryOptions?: { ttlMs?: number },
      ) => {
        // Production refuses an expired row too: its existence check does not filter on
        // the deadline, because "expired rows remain owner-managed until explicitly
        // claimed" (plugin-blob-store.sqlite.ts). A stand-in that treated them as free
        // would let a caller drop its own expiry sweep and still pass.
        // Production also checks the entry size before it looks for the key (`prepareBlob`),
        // so a retry whose new record is too large is refused even though one is stored.
        if (options.maxBytesPerEntry !== undefined && bytes.byteLength > options.maxBytesPerEntry) {
          throw new Error(
            `plugin blob entry exceeds the configured ${options.maxBytesPerEntry} byte limit`,
          );
        }
        if (blobs.has(key)) {
          return false;
        }
        put(key, bytes, entryOptions?.ttlMs);
        return true;
      },
      lookup: async (key: string) => {
        if (!live(key)) {
          return undefined;
        }
        const bytes = blobs.get(key);
        return bytes ? { ...info(key), bytes } : undefined;
      },
      entries: async () => Array.from(blobs.keys(), info).filter((entry) => live(entry.key)),
      delete: async (key: string) => {
        const existed = blobs.has(key);
        drop(key);
        return existed;
      },
      deleteExpiredKey: async (key: string) => {
        if (!isExpired(key)) {
          return undefined;
        }
        drop(key);
        return key;
      },
      deleteExpired: async () => {
        const expired = Array.from(blobs.keys()).filter(isExpired);
        for (const key of expired) {
          drop(key);
        }
        return expired;
      },
      clear: async () => {
        blobs.clear();
        expiries.clear();
      },
    };
  };
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

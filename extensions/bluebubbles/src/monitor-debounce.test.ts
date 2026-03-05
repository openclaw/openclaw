import type { OpenClawConfig } from "openclaw/plugin-sdk/bluebubbles";
import { describe, expect, it, vi } from "vitest";
import type { ResolvedBlueBubblesAccount } from "./accounts.js";
import { createBlueBubblesDebounceRegistry } from "./monitor-debounce.js";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import type { BlueBubblesCoreRuntime, WebhookTarget } from "./monitor-shared.js";

type DebounceParams<T> = {
  debounceMs: number;
  buildKey: (item: T) => string;
  shouldDebounce?: (item: T) => boolean;
  onFlush: (entries: T[]) => Promise<void>;
  onError?: (error: unknown) => void;
};

function createMockTarget(): WebhookTarget {
  const createInboundDebouncer = vi.fn(<T>(params: DebounceParams<T>) => {
    const buckets = new Map<string, T[]>();

    return {
      enqueue: async (item: T) => {
        if (params.shouldDebounce && !params.shouldDebounce(item)) {
          await params.onFlush([item]);
          return;
        }
        const key = params.buildKey(item);
        const entries = buckets.get(key) ?? [];
        entries.push(item);
        buckets.set(key, entries);
      },
      flushKey: async (key: string) => {
        const entries = buckets.get(key) ?? [];
        buckets.delete(key);
        if (entries.length === 0) {
          return;
        }
        try {
          await params.onFlush(entries);
        } catch (error) {
          params.onError?.(error);
        }
      },
    };
  });

  const core = {
    channel: {
      debounce: {
        createInboundDebouncer,
        resolveInboundDebounceMs: vi.fn(() => 500),
      },
      text: {
        hasControlCommand: vi.fn(() => false),
      },
    },
    logging: {
      shouldLogVerbose: vi.fn(() => false),
    },
  } as unknown as BlueBubblesCoreRuntime;

  const account: ResolvedBlueBubblesAccount = {
    accountId: "default",
    enabled: true,
    configured: true,
    config: {
      serverUrl: "http://localhost:1234",
      password: "test-password",
    },
  };

  const config: OpenClawConfig = {};

  return {
    account,
    config,
    core,
    path: "/bluebubbles-webhook",
    runtime: {
      log: vi.fn(),
      error: vi.fn(),
    },
  };
}

describe("createBlueBubblesDebounceRegistry", () => {
  it("skips malformed null text entries instead of crashing the flush", async () => {
    const processMessage = vi.fn().mockResolvedValue(undefined);
    const registry = createBlueBubblesDebounceRegistry({ processMessage });
    const target = createMockTarget();
    const debouncer = registry.getOrCreateDebouncer(target);

    const malformed = {
      text: null,
      senderId: "+15551234567",
      isGroup: false,
      messageId: "msg-1",
    } as unknown as NormalizedWebhookMessage;

    const valid: NormalizedWebhookMessage = {
      text: "hello",
      senderId: "+15551234567",
      isGroup: false,
      messageId: "msg-1",
    };

    await debouncer.enqueue({ message: malformed, target });
    await debouncer.enqueue({ message: valid, target });
    await debouncer.flushKey("bluebubbles:default:msg:msg-1");

    expect(processMessage).toHaveBeenCalledTimes(1);
    expect(processMessage).toHaveBeenCalledWith(expect.objectContaining({ text: "hello" }), target);
    expect(target.runtime.error).not.toHaveBeenCalled();
  });
});

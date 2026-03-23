import { describe, expect, it, vi } from "vitest";
import { createBlueBubblesDebounceRegistry } from "./monitor-debounce.js";
import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import type { WebhookTarget } from "./monitor-shared.js";

function createMessage(
  overrides: Partial<NormalizedWebhookMessage> = {},
): NormalizedWebhookMessage {
  return {
    text: "hello",
    senderId: "+15551234567",
    senderIdExplicit: false,
    isGroup: false,
    fromMe: false,
    attachments: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

function createTarget(overrides: Partial<WebhookTarget> = {}): WebhookTarget {
  const rawDebouncer = {
    enqueue: vi.fn(async () => undefined),
    flushKey: vi.fn(async () => undefined),
  };
  const target = {
    account: { accountId: "default" },
    config: {},
    runtime: { log: vi.fn(), error: vi.fn() },
    core: {
      logging: { shouldLogVerbose: () => false },
      channel: {
        text: { hasControlCommand: () => false },
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: vi.fn(() => rawDebouncer),
        },
      },
    },
    ...overrides,
  } as unknown as WebhookTarget;
  return target;
}

describe("createBlueBubblesDebounceRegistry", () => {
  it("reuses the wrapped debouncer for later updated-message webhooks", async () => {
    const registry = createBlueBubblesDebounceRegistry({
      processMessage: async () => undefined,
    });
    const target = createTarget();

    const first = registry.getOrCreateDebouncer(target);
    const second = registry.getOrCreateDebouncer(target);

    expect(second).toBe(first);

    await second.enqueue({
      target,
      eventType: "updated-message",
      message: createMessage({
        messageId: "msg-1",
        associatedMessageGuid: "assoc-1",
      }),
    });

    const createdDebouncer = (
      target as unknown as {
        core: {
          channel: {
            debounce: {
              createInboundDebouncer: ReturnType<typeof vi.fn>;
            };
          };
        };
      }
    ).core.channel.debounce.createInboundDebouncer.mock.results[0]?.value as {
      enqueue: ReturnType<typeof vi.fn>;
      flushKey: ReturnType<typeof vi.fn>;
    };
    expect(createdDebouncer.flushKey).toHaveBeenCalledWith("bluebubbles:default:balloon:assoc-1");
    expect(createdDebouncer.enqueue).toHaveBeenCalledTimes(1);
  });

  it("flushes the pending msg bucket before assoc-only edits bypass debounce", async () => {
    const registry = createBlueBubblesDebounceRegistry({
      processMessage: async () => undefined,
    });
    const target = createTarget();

    const debouncer = registry.getOrCreateDebouncer(target);
    await debouncer.enqueue({
      target,
      eventType: "updated-message",
      message: createMessage({
        text: "edited",
        associatedMessageGuid: "assoc-2",
      }),
    });

    const createdDebouncer = (
      target as unknown as {
        core: {
          channel: {
            debounce: {
              createInboundDebouncer: ReturnType<typeof vi.fn>;
            };
          };
        };
      }
    ).core.channel.debounce.createInboundDebouncer.mock.results[0]?.value as {
      enqueue: ReturnType<typeof vi.fn>;
      flushKey: ReturnType<typeof vi.fn>;
    };
    expect(createdDebouncer.flushKey).toHaveBeenNthCalledWith(
      1,
      "bluebubbles:default:balloon:assoc-2",
    );
    expect(createdDebouncer.flushKey).toHaveBeenNthCalledWith(2, "bluebubbles:default:msg:assoc-2");
  });

  it("serializes stable updated-message edits for the same identity", async () => {
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const target = createTarget();
    const registry = createBlueBubblesDebounceRegistry({
      processMessage: async () => undefined,
    });
    const debouncer = registry.getOrCreateDebouncer(target);
    const createdDebouncer = (
      target as unknown as {
        core: {
          channel: {
            debounce: {
              createInboundDebouncer: ReturnType<typeof vi.fn>;
            };
          };
        };
      }
    ).core.channel.debounce.createInboundDebouncer.mock.results[0]?.value as {
      enqueue: ReturnType<typeof vi.fn>;
      flushKey: ReturnType<typeof vi.fn>;
    };
    createdDebouncer.enqueue.mockImplementation(
      async (entry: { message: NormalizedWebhookMessage }) => {
        order.push(`start:${entry.message.text}`);
        if (entry.message.text === "first edit") {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        order.push(`end:${entry.message.text}`);
      },
    );

    const first = debouncer.enqueue({
      target,
      eventType: "updated-message",
      message: createMessage({ messageId: "msg-1", text: "first edit" }),
    });
    await Promise.resolve();
    const second = debouncer.enqueue({
      target,
      eventType: "updated-message",
      message: createMessage({ messageId: "msg-1", text: "second edit" }),
    });
    await Promise.resolve();

    expect(order).toEqual(["start:first edit"]);
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(order).toEqual([
      "start:first edit",
      "end:first edit",
      "start:second edit",
      "end:second edit",
    ]);
  });
});

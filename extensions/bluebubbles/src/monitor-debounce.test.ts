import { describe, expect, it } from "vitest";

import type { NormalizedWebhookMessage } from "./monitor-normalize.js";
import { createBlueBubblesDebounceRegistry } from "./monitor-debounce.js";

function buildMessage(overrides: Partial<NormalizedWebhookMessage> = {}): NormalizedWebhookMessage {
  return {
    text: "hello",
    senderId: "+15551234567",
    isGroup: false,
    ...overrides,
  };
}

describe("bluebubbles monitor debounce", () => {
  it("does not throw when combining entries with null text", async () => {
    const processed: NormalizedWebhookMessage[] = [];

    const registry = createBlueBubblesDebounceRegistry({
      processMessage: async (message) => {
        processed.push(message);
      },
    });

    const target = {
      account: { accountId: "default", config: {} },
      config: {},
      runtime: {},
      core: {
        logging: { shouldLogVerbose: () => false },
        channel: {
          debounce: {
            resolveInboundDebounceMs: () => 0,
            createInboundDebouncer: ({ onFlush }: any) => {
              let flushEntries: any[] = [];
              return {
                enqueue: async (entry: any) => {
                  flushEntries.push(entry);
                },
                flushKey: async () => {
                  await onFlush(flushEntries);
                  flushEntries = [];
                },
              };
            },
          },
          text: { hasControlCommand: () => false },
        },
      },
    } as any;

    const debouncer = registry.getOrCreateDebouncer(target);

    await debouncer.enqueue({ message: buildMessage({ text: null as any }), target });
    await debouncer.enqueue({ message: buildMessage({ text: "  hello  " }), target });
    await debouncer.flushKey("ignored");

    expect(processed).toHaveLength(1);
    expect(processed[0].text).toBe("hello");
  });
});

import { vi } from "vitest";

export function createFeishuClientMockModule() {
  return {
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
    createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
  };
}

export function createFeishuRuntimeMockModule() {
  return {
    getFeishuRuntime: () => ({
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: () => ({
            enqueue: async () => {},
            flushKey: async () => {},
          }),
        },
        text: {
          hasControlCommand: () => false,
        },
      },
    }),
  };
}

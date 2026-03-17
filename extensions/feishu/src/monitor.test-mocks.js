import { vi } from "vitest";
function createFeishuClientMockModule() {
  return {
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
    createEventDispatcher: vi.fn(() => ({ register: vi.fn() }))
  };
}
function createFeishuRuntimeMockModule() {
  return {
    getFeishuRuntime: () => ({
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: () => ({
            enqueue: async () => {
            },
            flushKey: async () => {
            }
          })
        },
        text: {
          hasControlCommand: () => false
        }
      }
    })
  };
}
export {
  createFeishuClientMockModule,
  createFeishuRuntimeMockModule
};

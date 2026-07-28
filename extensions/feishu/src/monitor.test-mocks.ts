// Feishu plugin module implements monitor mocks behavior.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createChannelIngressQueueForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { vi } from "vitest";

export function createFeishuClientMockModule(): {
  createFeishuWSClient: () => { start: () => void; close: () => void };
  createEventDispatcher: () => { register: () => void };
} {
  return {
    createFeishuWSClient: vi.fn(() => ({ start: vi.fn(), close: vi.fn() })),
    createEventDispatcher: vi.fn(() => ({ register: vi.fn() })),
  };
}

export function createFeishuRuntimeMockModule(): {
  getFeishuRuntime: () => {
    state: Pick<PluginRuntime["state"], "openChannelIngressQueue">;
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => number;
        createInboundDebouncer: () => {
          enqueue: () => Promise<void>;
          flushKey: () => Promise<void>;
        };
      };
      text: {
        hasControlCommand: () => boolean;
      };
    };
  };
} {
  return {
    getFeishuRuntime: () => ({
      state: {
        // Real SDK dispatchers start the canonical SQLite-backed ingress monitor.
        // Keep webhook tests on that production queue instead of bypassing persistence.
        openChannelIngressQueue: <TPayload, TMetadata = unknown, TCompletedMetadata = unknown>(
          options?: Parameters<PluginRuntime["state"]["openChannelIngressQueue"]>[0],
        ) =>
          createChannelIngressQueueForTests<TPayload, TMetadata, TCompletedMetadata>({
            ...options,
            channelId: "feishu",
          }),
      },
      channel: {
        debounce: {
          resolveInboundDebounceMs: () => 0,
          createInboundDebouncer: () => ({
            enqueue: async () => {},
            flushKey: async () => {},
            cancelKey: () => false,
          }),
        },
        text: {
          hasControlCommand: () => false,
        },
      },
    }),
  };
}

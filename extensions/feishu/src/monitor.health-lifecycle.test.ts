import type { ClawdbotConfig } from "openclaw/plugin-sdk/feishu";
import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorFeishuProvider, stopFeishuMonitor } from "./monitor.js";

// ── Mocks ─────────────────────────────────────────────────────────────

const probeFeishuMock = vi.hoisted(() => vi.fn());
const feishuClientMockModule = vi.hoisted(() => ({
  createFeishuWSClient: vi.fn(() => ({ start: vi.fn() })),
  createEventDispatcher: vi.fn(() => {
    let handlers: Record<string, (...args: unknown[]) => Promise<void>> = {};
    return {
      register: vi.fn((registrations: Record<string, (...args: unknown[]) => Promise<void>>) => {
        handlers = { ...handlers, ...registrations };
      }),
      /** Test helper: fire a registered event by name. */
      _fire: async (name: string, data?: unknown) => {
        if (handlers[name]) {
          await handlers[name](data);
        }
      },
      _handlers: () => handlers,
    };
  }),
}));
const feishuRuntimeMockModule = vi.hoisted(() => ({
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
}));

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));
vi.mock("./client.js", () => feishuClientMockModule);
vi.mock("./runtime.js", () => feishuRuntimeMockModule);

// ── Helpers ───────────────────────────────────────────────────────────

function buildSingleAccountConfig(mode: "websocket" | "webhook" = "websocket"): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_test",
        appSecret: "secret_test", // pragma: allowlist secret
        connectionMode: mode,
      },
    },
  } as ClawdbotConfig;
}

afterEach(() => {
  stopFeishuMonitor();
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("Feishu monitor health lifecycle", () => {
  it("reports connected status and mode=websocket via setStatus on WS start", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      botOpenId: "bot_test",
      botName: "TestBot",
    });

    const abortController = new AbortController();
    const setStatus = vi.fn();

    const monitorPromise = monitorFeishuProvider({
      config: buildSingleAccountConfig("websocket"),
      abortSignal: abortController.signal,
      setStatus,
    });

    // Let microtasks settle so start() is called
    await new Promise((r) => setTimeout(r, 50));

    try {
      // setStatus should have been called with connected: true and mode: websocket
      expect(setStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          connected: true,
          mode: "websocket",
        }),
      );
      const patch = setStatus.mock.calls.find(
        (c: unknown[]) => (c[0] as Record<string, unknown>).connected === true,
      )?.[0] as Record<string, unknown> | undefined;
      expect(patch).toBeDefined();
      expect(patch!.lastEventAt).toBeTypeOf("number");
      expect(patch!.lastConnectedAt).toBeTypeOf("number");
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("updates lastEventAt when an inbound message event is received", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      botOpenId: "bot_test",
      botName: "TestBot",
    });

    const abortController = new AbortController();
    const setStatus = vi.fn();

    const monitorPromise = monitorFeishuProvider({
      config: buildSingleAccountConfig("websocket"),
      abortSignal: abortController.signal,
      setStatus,
    });

    // Let microtasks settle
    await new Promise((r) => setTimeout(r, 50));

    try {
      // Reset to isolate event-driven calls
      const connectCalls = setStatus.mock.calls.length;

      // Fire a message event through the dispatcher
      const dispatcher = feishuClientMockModule.createEventDispatcher.mock.results.at(-1)?.value;
      expect(dispatcher).toBeDefined();
      await dispatcher._fire("im.message.receive_v1", {
        message: {
          message_id: "om_test_1",
          chat_id: "oc_test",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "hello" }),
        },
        sender: {
          sender_id: { open_id: "ou_sender" },
        },
      });

      // Should have a new setStatus call with lastEventAt
      const eventCalls = setStatus.mock.calls.slice(connectCalls);
      expect(eventCalls.length).toBeGreaterThanOrEqual(1);
      const eventPatch = eventCalls[0][0] as Record<string, unknown>;
      expect(eventPatch.lastEventAt).toBeTypeOf("number");
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("updates lastEventAt on reaction events", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      botOpenId: "bot_test",
      botName: "TestBot",
    });

    const abortController = new AbortController();
    const setStatus = vi.fn();

    const monitorPromise = monitorFeishuProvider({
      config: buildSingleAccountConfig("websocket"),
      abortSignal: abortController.signal,
      setStatus,
    });

    await new Promise((r) => setTimeout(r, 50));

    try {
      const callsBefore = setStatus.mock.calls.length;

      const dispatcher = feishuClientMockModule.createEventDispatcher.mock.results.at(-1)?.value;
      await dispatcher._fire("im.message.reaction.created_v1", {
        message_id: "om_test_1",
        reaction_type: { emoji_type: "OK" },
        operator_type: "user",
        user_id: { open_id: "ou_sender" },
      });

      const newCalls = setStatus.mock.calls.slice(callsBefore);
      expect(newCalls.length).toBeGreaterThanOrEqual(1);
      expect((newCalls[0][0] as Record<string, unknown>).lastEventAt).toBeTypeOf("number");
    } finally {
      abortController.abort();
      await monitorPromise;
    }
  });

  it("does not call setStatus when callback is not provided", async () => {
    probeFeishuMock.mockResolvedValue({
      ok: true,
      botOpenId: "bot_test",
    });

    const abortController = new AbortController();

    // No setStatus — should not throw
    const monitorPromise = monitorFeishuProvider({
      config: buildSingleAccountConfig("websocket"),
      abortSignal: abortController.signal,
    });

    await new Promise((r) => setTimeout(r, 50));

    abortController.abort();
    await monitorPromise;
  });
});

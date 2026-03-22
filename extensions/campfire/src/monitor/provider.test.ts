import { afterEach, describe, expect, it, vi } from "vitest";
import type { CampfireWebhookPayload, ResolvedCampfireAccount } from "../types.js";
import { createCampfireGateway } from "./provider.js";

const validPayload: CampfireWebhookPayload = {
  user: { id: 42, name: "Alice" },
  room: {
    id: 7,
    name: "General",
    path: "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
  },
  message: {
    id: 99,
    body: { plain: "Hey help me" },
    path: "https://campfire.example.com/rooms/7/@99",
  },
};

function createAccount(overrides?: Partial<ResolvedCampfireAccount>): ResolvedCampfireAccount {
  return {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "https://campfire.example.com",
    botKey: "42-AbCdEf",
    allowFrom: [],
    webhookPath: "/channels/campfire/webhook/default",
    textChunkLimit: 4000,
    ...overrides,
  };
}

describe("campfire gateway", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers webhook ingress and forwards replies", async () => {
    const unregister = vi.fn();
    const registerRoute = vi.fn().mockReturnValue(unregister);
    const sendText = vi.fn().mockResolvedValue(undefined);

    const finalizeInboundContext = vi.fn((ctx: Record<string, unknown>) => ctx);
    const dispatchReplyWithBufferedBlockDispatcher = vi.fn().mockImplementation(
      async ({
        dispatcherOptions,
      }: {
        dispatcherOptions: {
          deliver: (payload: { text?: string; body?: string }) => Promise<void>;
        };
      }) => {
        await dispatcherOptions.deliver({ text: "Hello back" });
      },
    );

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount(),
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      abortSignal: abort.signal,
      getStatus: () => ({ accountId: "default" }),
      setStatus: () => {},
      channelRuntime: {
        reply: {
          finalizeInboundContext,
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    });

    const registered = registerRoute.mock.calls[0]?.[0];
    expect(registered).toBeTruthy();
    expect(registered.path).toBe("/channels/campfire/webhook/default");

    await registered.onInbound(validPayload);

    expect(finalizeInboundContext).toHaveBeenCalled();
    const finalizedCtx = finalizeInboundContext.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(finalizedCtx?.SessionKey).toMatch(/^agent:/);
    expect(finalizedCtx?.SessionKey).toContain(":account:default");
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
      "Hello back",
      "42-AbCdEf",
      4000,
    );

    abort.abort();
    await startPromise;
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it("drops inbound messages from blocked users", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount({ allowFrom: ["77"] }),
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      abortSignal: abort.signal,
      getStatus: () => ({ accountId: "default" }),
      setStatus: () => {},
      channelRuntime: {
        reply: {
          finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    });

    const registered = registerRoute.mock.calls[0]?.[0];
    await registered.onInbound(validPayload);

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();

    abort.abort();
    await startPromise;
  });

  it("does not allow sender-name matches in allowFrom", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount({ allowFrom: ["Alice"] }),
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      abortSignal: abort.signal,
      getStatus: () => ({ accountId: "default" }),
      setStatus: () => {},
      channelRuntime: {
        reply: {
          finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
          dispatchReplyWithBufferedBlockDispatcher,
        },
      },
    });

    const registered = registerRoute.mock.calls[0]?.[0];
    await registered.onInbound(validPayload);

    expect(dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();

    abort.abort();
    await startPromise;
  });

  it("marks command messages unauthorized when no allowFrom is configured", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);
    let finalizedCtx: Record<string, unknown> | undefined;

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount({ allowFrom: [] }),
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      abortSignal: abort.signal,
      getStatus: () => ({ accountId: "default" }),
      setStatus: () => {},
      channelRuntime: {
        reply: {
          finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => {
            finalizedCtx = ctx;
            return ctx;
          }),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const registered = registerRoute.mock.calls[0]?.[0];
    await registered.onInbound({
      ...validPayload,
      message: {
        ...validPayload.message,
        body: {
          plain: "!status",
        },
      },
    });

    expect(finalizedCtx?.CommandAuthorized).toBe(false);

    abort.abort();
    await startPromise;
  });

  it("honors commands.useAccessGroups=false for command authorization", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);
    let finalizedCtx: Record<string, unknown> | undefined;

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {
        commands: {
          useAccessGroups: false,
        },
      },
      accountId: "default",
      account: createAccount({ allowFrom: [] }),
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      abortSignal: abort.signal,
      getStatus: () => ({ accountId: "default" }),
      setStatus: () => {},
      channelRuntime: {
        reply: {
          finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => {
            finalizedCtx = ctx;
            return ctx;
          }),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const registered = registerRoute.mock.calls[0]?.[0];
    await registered.onInbound({
      ...validPayload,
      message: {
        ...validPayload.message,
        body: {
          plain: "!status",
        },
      },
    });

    expect(finalizedCtx?.CommandAuthorized).toBe(true);

    abort.abort();
    await startPromise;
  });

  it("reloads config before computing command authorization", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);
    const loadConfig = vi.fn(() => ({ commands: { useAccessGroups: true } }));
    let finalizedCtx: Record<string, unknown> | undefined;

    const gateway = createCampfireGateway({ registerRoute, sendText, loadConfig } as never);
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {
        commands: {
          useAccessGroups: false,
        },
      },
      accountId: "default",
      account: createAccount({ allowFrom: [] }),
      runtime: {
        log: () => {},
        error: () => {},
        exit: () => {},
      },
      abortSignal: abort.signal,
      getStatus: () => ({ accountId: "default" }),
      setStatus: () => {},
      channelRuntime: {
        reply: {
          finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => {
            finalizedCtx = ctx;
            return ctx;
          }),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockResolvedValue(undefined),
        },
      },
    });

    const registered = registerRoute.mock.calls[0]?.[0];
    await registered.onInbound({
      ...validPayload,
      message: {
        ...validPayload.message,
        body: {
          plain: "!status",
        },
      },
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(finalizedCtx?.CommandAuthorized).toBe(false);

    abort.abort();
    await startPromise;
  });
});

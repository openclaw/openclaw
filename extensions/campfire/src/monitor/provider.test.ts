import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
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
    botKey: "100-AbCdEf",
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
    const expectedRoute = resolveAgentRoute({
      cfg: {},
      channel: "campfire",
      accountId: "default",
      peer: { kind: "group", id: "7" },
    });
    expect(finalizedCtx?.SessionKey).toBe(expectedRoute.sessionKey);
    expect(dispatchReplyWithBufferedBlockDispatcher).toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith(
      "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
      "Hello back",
      "100-AbCdEf",
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

  it("authorizes command messages when allowFrom includes wildcard", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);
    let finalizedCtx: Record<string, unknown> | undefined;

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount({ allowFrom: ["*"] }),
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

    const gateway = createCampfireGateway({ registerRoute, sendText, loadConfig });
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

  it("skips webhook registration for disabled accounts", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const gateway = createCampfireGateway({ registerRoute });
    const abort = new AbortController();

    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount({ enabled: false }),
      abortSignal: abort.signal,
    });

    expect(registerRoute).not.toHaveBeenCalled();

    abort.abort();
    await startPromise;
  });

  it("skips webhook registration for unconfigured accounts", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const gateway = createCampfireGateway({ registerRoute });
    const abort = new AbortController();

    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount({ configured: false }),
      abortSignal: abort.signal,
    });

    expect(registerRoute).not.toHaveBeenCalled();

    abort.abort();
    await startPromise;
  });

  it("warns and waits when channelRuntime is missing", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const warnSpy = vi.fn();
    const gateway = createCampfireGateway({ registerRoute });
    const abort = new AbortController();

    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount(),
      abortSignal: abort.signal,
      log: { warn: warnSpy },
    });

    expect(registerRoute).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("channelRuntime is unavailable"));

    abort.abort();
    await startPromise;
  });

  it("falls back to ctx.cfg when config reload fails", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);
    const loadConfig = vi.fn().mockRejectedValue(new Error("config gone"));
    let finalizedCtx: Record<string, unknown> | undefined;

    const gateway = createCampfireGateway({ registerRoute, sendText, loadConfig });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {
        commands: { useAccessGroups: false },
      },
      accountId: "default",
      account: createAccount(),
      abortSignal: abort.signal,
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
      message: { ...validPayload.message, body: { plain: "!status" } },
    });

    expect(loadConfig).toHaveBeenCalled();
    // Falls back to ctx.cfg which has useAccessGroups: false → commands authorized
    expect(finalizedCtx?.CommandAuthorized).toBe(true);

    abort.abort();
    await startPromise;
  });

  it("delivers body field when text field is absent", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount(),
      abortSignal: abort.signal,
      channelRuntime: {
        reply: {
          finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(
            async ({
              dispatcherOptions,
            }: {
              dispatcherOptions: {
                deliver: (p: { text?: string; body?: string }) => Promise<void>;
              };
            }) => {
              await dispatcherOptions.deliver({ body: "fallback body" });
            },
          ),
        },
      },
    });

    const registered = registerRoute.mock.calls[0]?.[0];
    await registered.onInbound(validPayload);

    expect(sendText).toHaveBeenCalledWith(
      "https://campfire.example.com/rooms/7/42-AbCdEf/messages",
      "fallback body",
      "100-AbCdEf",
      4000,
    );

    abort.abort();
    await startPromise;
  });

  it("skips delivery when reply payload has no text or body", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount(),
      abortSignal: abort.signal,
      channelRuntime: {
        reply: {
          finalizeInboundContext: vi.fn((ctx: Record<string, unknown>) => ctx),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn().mockImplementation(
            async ({
              dispatcherOptions,
            }: {
              dispatcherOptions: {
                deliver: (p: { text?: string; body?: string }) => Promise<void>;
              };
            }) => {
              await dispatcherOptions.deliver({});
            },
          ),
        },
      },
    });

    const registered = registerRoute.mock.calls[0]?.[0];
    await registered.onInbound(validPayload);

    expect(sendText).not.toHaveBeenCalled();

    abort.abort();
    await startPromise;
  });

  it("drops inbound messages authored by the configured bot", async () => {
    const registerRoute = vi.fn().mockReturnValue(() => {});
    const sendText = vi.fn().mockResolvedValue(undefined);

    const dispatchReplyWithBufferedBlockDispatcher = vi.fn();

    const gateway = createCampfireGateway({ registerRoute, sendText });
    const abort = new AbortController();
    const startPromise = gateway.startAccount({
      cfg: {},
      accountId: "default",
      account: createAccount({ botKey: "42-AbCdEf" }),
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
});

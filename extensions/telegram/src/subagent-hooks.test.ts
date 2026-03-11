import type { OpenClawPluginApi } from "openclaw/plugin-sdk/telegram";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerTelegramSubagentHooks } from "./subagent-hooks.js";

type SessionBindingRecord = {
  status: "active";
  conversation: {
    channel: string;
    accountId: string;
    conversationId: string;
  };
};

const hookMocks = vi.hoisted(() => ({
  resolveTelegramAccount: vi.fn((params?: { accountId?: string }) => ({
    accountId: params?.accountId?.trim() || "default",
  })),
  ensureTelegramThreadBindingManager: vi.fn(),
  getSessionBindingService: vi.fn(() => ({
    getCapabilities: vi.fn(() => ({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    })),
    bind: vi.fn(async () => ({
      bindingId: "default:-100123:topic:55",
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100123:topic:55",
      },
      status: "active",
      boundAt: 1,
    })),
    listBySession: vi.fn((): SessionBindingRecord[] => []),
    unbind: vi.fn(async () => []),
  })),
}));

vi.mock("openclaw/plugin-sdk/telegram", () => ({
  resolveTelegramAccount: hookMocks.resolveTelegramAccount,
}));

vi.mock("../../../src/infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: hookMocks.getSessionBindingService,
}));

vi.mock("../../../src/telegram/thread-bindings.js", () => ({
  ensureTelegramThreadBindingManager: hookMocks.ensureTelegramThreadBindingManager,
}));

function registerHandlersForTest(
  config: Record<string, unknown> = {
    channels: {
      telegram: {
        threadBindings: {
          spawnSubagentSessions: true,
        },
      },
    },
  },
) {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const api = {
    config,
    on: (hookName: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(hookName, handler);
    },
  } as unknown as OpenClawPluginApi;
  registerTelegramSubagentHooks(api);
  return handlers;
}

function getRequiredHandler(
  handlers: Map<string, (event: unknown, ctx: unknown) => unknown>,
  hookName: string,
): (event: unknown, ctx: unknown) => unknown {
  const handler = handlers.get(hookName);
  if (!handler) {
    throw new Error(`expected ${hookName} hook handler`);
  }
  return handler;
}

function getBindingServiceMock() {
  return hookMocks.getSessionBindingService.mock.results.at(-1)?.value as {
    getCapabilities: ReturnType<typeof vi.fn>;
    bind: ReturnType<typeof vi.fn>;
    listBySession: ReturnType<typeof vi.fn>;
    unbind: ReturnType<typeof vi.fn>;
  };
}

function createSpawnEvent(overrides?: {
  childSessionKey?: string;
  agentId?: string;
  label?: string;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string;
  };
  threadRequested?: boolean;
}) {
  const base = {
    childSessionKey: "agent:main:subagent:child",
    agentId: "main",
    label: "banana",
    requester: {
      channel: "telegram",
      accountId: "default",
      to: "telegram:-100123",
      threadId: "55",
    },
    threadRequested: true,
  };
  return {
    ...base,
    ...overrides,
    requester: {
      ...base.requester,
      ...(overrides?.requester ?? {}),
    },
  };
}

describe("telegram subagent hook handlers", () => {
  beforeEach(() => {
    hookMocks.resolveTelegramAccount.mockClear();
    hookMocks.ensureTelegramThreadBindingManager.mockClear();
    hookMocks.getSessionBindingService.mockClear();
  });

  it("registers telegram subagent hooks", () => {
    const handlers = registerHandlersForTest();
    expect(handlers.has("subagent_spawning")).toBe(true);
    expect(handlers.has("subagent_delivery_target")).toBe(true);
    expect(handlers.has("subagent_ended")).toBe(true);
  });

  it("prewarms the manager and binds the current telegram topic", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_spawning");

    const result = await handler(createSpawnEvent(), {});
    const bindingService = getBindingServiceMock();

    expect(hookMocks.ensureTelegramThreadBindingManager).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      accountId: "default",
    });
    expect(bindingService.getCapabilities).toHaveBeenCalledWith({
      channel: "telegram",
      accountId: "default",
    });
    expect(bindingService.bind).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      targetKind: "subagent",
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-100123:topic:55",
      },
      placement: "current",
      metadata: {
        agentId: "main",
        label: "banana",
        boundBy: "system",
      },
    });
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("returns an availability error when telegram binding capabilities are missing", async () => {
    hookMocks.getSessionBindingService.mockReturnValueOnce({
      getCapabilities: vi.fn(() => ({
        adapterAvailable: false,
        bindSupported: false,
        unbindSupported: false,
        placements: [],
      })),
      bind: vi.fn(),
      listBySession: vi.fn((): SessionBindingRecord[] => []),
      unbind: vi.fn(async () => []),
    });
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_spawning");

    const result = await handler(createSpawnEvent(), {});

    expect(result).toMatchObject({
      status: "error",
      error: "Thread bindings are unavailable for telegram.",
    });
  });

  it("resolves completion delivery back to the bound telegram topic", () => {
    hookMocks.getSessionBindingService.mockReturnValueOnce({
      getCapabilities: vi.fn(() => ({
        adapterAvailable: true,
        bindSupported: true,
        unbindSupported: true,
        placements: ["current"],
      })),
      bind: vi.fn(async () => ({
        bindingId: "default:-100123:topic:55",
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        conversation: {
          channel: "telegram",
          accountId: "default",
          conversationId: "-100123:topic:55",
        },
        status: "active",
        boundAt: 1,
      })),
      listBySession: vi.fn((): SessionBindingRecord[] => [
        {
          status: "active",
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "-100123:topic:55",
          },
        },
      ]),
      unbind: vi.fn(async () => []),
    });
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_delivery_target");

    const result = handler(
      {
        childSessionKey: "agent:main:subagent:child",
        requesterOrigin: {
          channel: "telegram",
          accountId: "default",
          to: "channel:-100123",
          threadId: "55",
        },
        expectsCompletionMessage: true,
      },
      {},
    );

    expect(result).toEqual({
      origin: {
        channel: "telegram",
        accountId: "default",
        to: "channel:-100123",
        threadId: "55",
      },
    });
  });

  it("unbinds telegram session routing on subagent_ended", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHandler(handlers, "subagent_ended");

    await handler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
      },
      {},
    );

    const bindingService = getBindingServiceMock();
    expect(bindingService.unbind).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      reason: "subagent-complete",
    });
  });
});

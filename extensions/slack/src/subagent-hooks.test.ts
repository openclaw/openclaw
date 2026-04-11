import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "../../../test/helpers/plugins/subagent-hooks.js";

type SlackBindingRecordLike = {
  accountId: string;
  channelId: string;
  threadTs: string;
};

type MockResolvedSlackAccount = {
  accountId: string;
};

const hookMocks = vi.hoisted(() => ({
  resolveSlackAccount: vi.fn(
    (params?: { accountId?: string }): MockResolvedSlackAccount => ({
      accountId: params?.accountId?.trim() || "default",
    }),
  ),
  autoBindSpawnedSlackSubagent: vi.fn(
    async (): Promise<SlackBindingRecordLike | null> => ({
      accountId: "work",
      channelId: "C1234567",
      threadTs: "1710000000.000100",
    }),
  ),
  listSlackThreadBindingsBySessionKey: vi.fn((_params?: unknown): SlackBindingRecordLike[] => []),
  unbindSlackThreadBindingsBySessionKey: vi.fn(() => []),
}));

let registerSlackSubagentHooks: typeof import("./subagent-hooks.js").registerSlackSubagentHooks;

vi.mock("./accounts.js", () => ({
  resolveSlackAccount: hookMocks.resolveSlackAccount,
}));
vi.mock("./thread-bindings.js", () => ({
  autoBindSpawnedSlackSubagent: hookMocks.autoBindSpawnedSlackSubagent,
  listSlackThreadBindingsBySessionKey: hookMocks.listSlackThreadBindingsBySessionKey,
  unbindSlackThreadBindingsBySessionKey: hookMocks.unbindSlackThreadBindingsBySessionKey,
  parseSlackChannelIdFromTo: (to: string | undefined): string | undefined => {
    const trimmed = typeof to === "string" ? to.trim() : undefined;
    if (!trimmed) {
      return undefined;
    }
    if (trimmed.toLowerCase().startsWith("channel:")) {
      const rest = trimmed.slice("channel:".length).trim();
      return rest || undefined;
    }
    return trimmed;
  },
}));

function registerHandlersForTest(
  config: Record<string, unknown> = {
    channels: {
      slack: {
        threadBindings: {
          spawnSubagentSessions: true,
        },
      },
    },
  },
) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: registerSlackSubagentHooks,
  });
}

function resolveSubagentDeliveryTargetForTest(requesterOrigin: {
  channel: string;
  accountId: string;
  to: string;
  threadId?: string;
}) {
  const handlers = registerHandlersForTest();
  const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");
  return handler(
    {
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin,
      childRunId: "run-1",
      spawnMode: "session",
      expectsCompletionMessage: true,
    },
    {},
  );
}

function createSpawnEvent(overrides?: {
  childSessionKey?: string;
  agentId?: string;
  label?: string;
  mode?: string;
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string;
  };
  threadRequested?: boolean;
}): {
  childSessionKey: string;
  agentId: string;
  label: string;
  mode: string;
  requester: {
    channel: string;
    accountId: string;
    to: string;
    threadId?: string;
  };
  threadRequested: boolean;
} {
  const base = {
    childSessionKey: "agent:main:subagent:child",
    agentId: "main",
    label: "banana",
    mode: "session",
    requester: {
      channel: "slack",
      accountId: "work",
      to: "channel:C1234567",
      threadId: "1710000000.000100",
    },
    threadRequested: true,
  };
  return {
    ...base,
    ...overrides,
    requester: {
      ...base.requester,
      ...overrides?.requester,
    },
  };
}

async function runSubagentSpawning(config?: Record<string, unknown>, event = createSpawnEvent()) {
  const handlers = registerHandlersForTest(config);
  const handler = getRequiredHookHandler(handlers, "subagent_spawning");
  return await handler(event, {});
}

async function expectSubagentSpawningError(params?: {
  config?: Record<string, unknown>;
  errorContains?: string;
  event?: ReturnType<typeof createSpawnEvent>;
}) {
  const result = await runSubagentSpawning(params?.config, params?.event);
  expect(hookMocks.autoBindSpawnedSlackSubagent).not.toHaveBeenCalled();
  expect(result).toMatchObject({ status: "error" });
  if (params?.errorContains) {
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toContain(params.errorContains);
  }
}

describe("slack subagent hook handlers", () => {
  beforeAll(async () => {
    ({ registerSlackSubagentHooks } = await import("./subagent-hooks.js"));
  });

  beforeEach(() => {
    hookMocks.resolveSlackAccount.mockClear();
    hookMocks.resolveSlackAccount.mockImplementation((params?: { accountId?: string }) => ({
      accountId: params?.accountId?.trim() || "default",
    }));
    hookMocks.autoBindSpawnedSlackSubagent.mockClear();
    hookMocks.autoBindSpawnedSlackSubagent.mockResolvedValue({
      accountId: "work",
      channelId: "C1234567",
      threadTs: "1710000000.000100",
    });
    hookMocks.listSlackThreadBindingsBySessionKey.mockClear();
    hookMocks.unbindSlackThreadBindingsBySessionKey.mockClear();
  });

  it("binds thread routing on subagent_spawning", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_spawning");

    const result = await handler(createSpawnEvent(), {});

    expect(hookMocks.autoBindSpawnedSlackSubagent).toHaveBeenCalledTimes(1);
    expect(hookMocks.autoBindSpawnedSlackSubagent).toHaveBeenCalledWith({
      accountId: "work",
      channel: "slack",
      to: "channel:C1234567",
      threadId: "1710000000.000100",
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "banana",
      boundBy: "system",
    });
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("returns error when thread-bound subagent spawn is disabled", async () => {
    await expectSubagentSpawningError({
      config: {
        channels: {
          slack: {
            threadBindings: {
              spawnSubagentSessions: false,
            },
          },
        },
      },
      errorContains: "spawnSubagentSessions=true",
    });
  });

  it("returns error when global thread bindings are disabled", async () => {
    await expectSubagentSpawningError({
      config: {
        session: {
          threadBindings: {
            enabled: false,
          },
        },
        channels: {
          slack: {
            threadBindings: {
              spawnSubagentSessions: true,
            },
          },
        },
      },
      errorContains: "threadBindings.enabled=true",
    });
  });

  it("allows account-level threadBindings.enabled to override global disable", async () => {
    const result = await runSubagentSpawning({
      session: {
        threadBindings: {
          enabled: false,
        },
      },
      channels: {
        slack: {
          accounts: {
            work: {
              threadBindings: {
                enabled: true,
                spawnSubagentSessions: true,
              },
            },
          },
        },
      },
    });

    expect(hookMocks.autoBindSpawnedSlackSubagent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: "ok", threadBindingReady: true });
  });

  it("defaults thread-bound subagent spawn to disabled when unset", async () => {
    await expectSubagentSpawningError({
      config: {
        channels: {
          slack: {
            threadBindings: {},
          },
        },
      },
    });
  });

  it("no-ops when thread binding is requested on non-slack channel", async () => {
    const result = await runSubagentSpawning(
      undefined,
      createSpawnEvent({
        requester: {
          channel: "signal",
          accountId: "",
          to: "+123",
          threadId: undefined,
        },
      }),
    );

    expect(hookMocks.autoBindSpawnedSlackSubagent).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("no-ops when threadRequested is false", async () => {
    const result = await runSubagentSpawning(
      undefined,
      createSpawnEvent({ threadRequested: false }),
    );

    expect(hookMocks.autoBindSpawnedSlackSubagent).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("returns error when thread bind fails", async () => {
    hookMocks.autoBindSpawnedSlackSubagent.mockResolvedValueOnce(null);
    const result = await runSubagentSpawning();

    expect(result).toMatchObject({ status: "error" });
    const errorText = (result as { error?: string }).error ?? "";
    expect(errorText).toMatch(/unable to bind a slack thread/i);
  });

  it("unbinds thread routing on subagent_ended", () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_ended");

    handler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
        accountId: "work",
      },
      {},
    );

    expect(hookMocks.unbindSlackThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(hookMocks.unbindSlackThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
      reason: "subagent-complete",
    });
  });

  it("resolves delivery target from matching bound thread", () => {
    hookMocks.listSlackThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", channelId: "C9999999", threadTs: "1710000000.000777" },
    ]);
    const result = resolveSubagentDeliveryTargetForTest({
      channel: "slack",
      accountId: "work",
      to: "channel:C9999999",
      threadId: "1710000000.000777",
    });

    expect(hookMocks.listSlackThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
    });
    expect(result).toEqual({
      origin: {
        channel: "slack",
        accountId: "work",
        to: "channel:C9999999",
        threadId: "1710000000.000777",
      },
    });
  });

  it("falls back to single-binding match when only one binding exists for the session", () => {
    hookMocks.listSlackThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", channelId: "C8888888", threadTs: "1710000000.000888" },
    ]);
    const result = resolveSubagentDeliveryTargetForTest({
      channel: "slack",
      accountId: "work",
      to: "channel:CMISSING",
    });

    expect(result).toEqual({
      origin: {
        channel: "slack",
        accountId: "work",
        to: "channel:C8888888",
        threadId: "1710000000.000888",
      },
    });
  });

  it("keeps original routing when delivery target is ambiguous across channels", () => {
    hookMocks.listSlackThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", channelId: "C7777777", threadTs: "1710000000.000777" },
      { accountId: "work", channelId: "C6666666", threadTs: "1710000000.000666" },
    ]);
    const result = resolveSubagentDeliveryTargetForTest({
      channel: "slack",
      accountId: "work",
      to: "channel:CMISSING",
    });

    expect(result).toBeUndefined();
  });
});

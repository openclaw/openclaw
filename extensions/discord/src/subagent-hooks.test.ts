import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleDiscordSubagentSpawning } from "./subagent-hooks.js";

type ThreadBindingRecord = {
  accountId: string;
  threadId: string;
};

type MockResolvedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  config: {
    threadBindings?: {
      enabled?: boolean;
      spawnSessions?: boolean;
    };
    subagentProgress?: {
      enabled?: boolean;
      reactions?: {
        enabled?: boolean;
        runningOrdinals?: string[];
        failure?: string;
      };
      typing?: {
        enabled?: boolean;
        intervalMs?: number;
        maxDurationMs?: number;
      };
    };
  };
};

type MockResolveDiscordAccountParams = {
  cfg?: {
    channels?: {
      discord?: {
        enabled?: boolean;
        defaultAccount?: string;
        subagentProgress?: MockResolvedDiscordAccount["config"]["subagentProgress"];
        threadBindings?: MockResolvedDiscordAccount["config"]["threadBindings"];
        accounts?: Record<
          string,
          {
            enabled?: boolean;
            threadBindings?: MockResolvedDiscordAccount["config"]["threadBindings"];
            subagentProgress?: MockResolvedDiscordAccount["config"]["subagentProgress"];
          }
        >;
      };
    };
  };
  accountId?: string;
};

const hookMocks = vi.hoisted(() => {
  const resolveDiscordAccountImpl = (
    params?: MockResolveDiscordAccountParams,
  ): MockResolvedDiscordAccount => {
    const accountId =
      params?.accountId?.trim() || params?.cfg?.channels?.discord?.defaultAccount || "default";
    const accountConfig = params?.cfg?.channels?.discord?.accounts?.[accountId];
    const rootConfig = params?.cfg?.channels?.discord;
    return {
      accountId,
      enabled: rootConfig?.enabled !== false && accountConfig?.enabled !== false,
      config: {
        threadBindings: accountConfig?.threadBindings ??
          rootConfig?.threadBindings ?? {
            spawnSessions: true,
          },
        subagentProgress: accountConfig?.subagentProgress ?? rootConfig?.subagentProgress,
      },
    };
  };
  return {
    resolveDiscordAccountImpl,
    resolveDiscordAccount: vi.fn(resolveDiscordAccountImpl),
    autoBindSpawnedDiscordSubagent: vi.fn(
      async (): Promise<{ threadId: string } | null> => ({
        threadId: "thread-1",
      }),
    ),
    listThreadBindingsBySessionKey: vi.fn((_params?: unknown): ThreadBindingRecord[] => []),
    unbindThreadBindingsBySessionKey: vi.fn(() => []),
    reactMessageDiscord: vi.fn(async () => ({ ok: true })),
    removeReactionDiscord: vi.fn(async () => ({ ok: true })),
    sendTypingDiscord: vi.fn(async (channelId: string) => ({
      ok: true,
      channelId,
    })),
  };
});

let registerDiscordSubagentHooks: typeof import("../subagent-hooks-api.js").registerDiscordSubagentHooks;
let handleDiscordSubagentProgressEnded: typeof import("./subagent-progress.js").handleDiscordSubagentProgressEnded;
let resetDiscordSubagentProgressForTest: typeof import("./subagent-progress.js").resetDiscordSubagentProgressForTest;

vi.mock("./accounts.js", () => ({
  resolveDiscordAccount: hookMocks.resolveDiscordAccount,
}));
vi.mock("./monitor/thread-bindings.js", () => ({
  autoBindSpawnedDiscordSubagent: hookMocks.autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey: hookMocks.listThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKey: hookMocks.unbindThreadBindingsBySessionKey,
}));
vi.mock("./send.reactions.js", () => ({
  reactMessageDiscord: hookMocks.reactMessageDiscord,
  removeReactionDiscord: hookMocks.removeReactionDiscord,
}));
vi.mock("./send.typing.js", () => ({
  sendTypingDiscord: hookMocks.sendTypingDiscord,
}));

function registerHandlersForTest(
  config: Record<string, unknown> = {
    channels: {
      discord: {
        threadBindings: {
          spawnSessions: true,
        },
      },
    },
  },
) {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config,
    register: (api) => {
      registerDiscordSubagentHooks(api);
      api.on("subagent_spawning", (event) => handleDiscordSubagentSpawning(api, event));
    },
  });
}

async function resolveSubagentDeliveryTargetForTest(requesterOrigin: {
  channel: string;
  accountId: string;
  to: string;
  threadId?: string;
}) {
  const handlers = registerHandlersForTest();
  const handler = getRequiredHookHandler(handlers, "subagent_delivery_target");
  return await handler(
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
    accountId?: string | undefined;
    to?: string;
    sourceTo?: string;
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
    accountId?: string;
    to: string;
    sourceTo?: string;
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
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "456",
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

function createSpawnEventWithoutThread() {
  return createSpawnEvent({
    label: "",
    requester: { threadId: undefined },
  });
}

async function runSubagentSpawning(
  config?: Record<string, unknown>,
  event = createSpawnEventWithoutThread(),
) {
  const handlers = registerHandlersForTest(config);
  const handler = getRequiredHookHandler(handlers, "subagent_spawning");
  return await handler(event, {});
}

function expectSubagentHookError(result: unknown): {
  status: "error";
  error: string;
} {
  expect((result as { status?: unknown } | undefined)?.status).toBe("error");
  const error = (result as { error?: unknown } | undefined)?.error;
  expect(typeof error).toBe("string");
  return result as { status: "error"; error: string };
}

async function expectSubagentSpawningError(params?: {
  config?: Record<string, unknown>;
  errorContains?: string;
  event?: ReturnType<typeof createSpawnEvent>;
}) {
  const result = await runSubagentSpawning(params?.config, params?.event);
  expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
  const errorResult = expectSubagentHookError(result);
  if (params?.errorContains) {
    expect(errorResult.error).toContain(params.errorContains);
  }
}

function reactMessageDiscordEmojis(): string[] {
  return (
    hookMocks.reactMessageDiscord.mock.calls as unknown as Array<
      [channelId: string, messageId: string, emoji: string, opts: unknown]
    >
  ).map((call) => call[2]);
}

function removeReactionDiscordEmojis(): string[] {
  return (
    hookMocks.removeReactionDiscord.mock.calls as unknown as Array<
      [channelId: string, messageId: string, emoji: string, opts: unknown]
    >
  ).map((call) => call[2]);
}

describe("discord subagent hook handlers", () => {
  beforeAll(async () => {
    ({ registerDiscordSubagentHooks } = await import("../subagent-hooks-api.js"));
    ({ handleDiscordSubagentProgressEnded, resetDiscordSubagentProgressForTest } =
      await import("./subagent-progress.js"));
  });

  beforeEach(() => {
    vi.useRealTimers();
    resetDiscordSubagentProgressForTest();
    hookMocks.resolveDiscordAccount.mockClear();
    hookMocks.resolveDiscordAccount.mockImplementation(hookMocks.resolveDiscordAccountImpl);
    hookMocks.autoBindSpawnedDiscordSubagent.mockClear();
    hookMocks.listThreadBindingsBySessionKey.mockClear();
    hookMocks.unbindThreadBindingsBySessionKey.mockClear();
    hookMocks.reactMessageDiscord.mockClear();
    hookMocks.reactMessageDiscord.mockResolvedValue({ ok: true });
    hookMocks.removeReactionDiscord.mockClear();
    hookMocks.removeReactionDiscord.mockResolvedValue({ ok: true });
    hookMocks.sendTypingDiscord.mockClear();
    hookMocks.sendTypingDiscord.mockImplementation(async (channelId: string) => ({
      ok: true,
      channelId,
    }));
  });

  it("binds thread routing on subagent_spawning", async () => {
    const config = {
      channels: {
        discord: {
          threadBindings: {
            spawnSessions: true,
          },
        },
      },
    };
    const handlers = registerHandlersForTest(config);
    const handler = getRequiredHookHandler(handlers, "subagent_spawning");

    const result = await handler(createSpawnEvent(), {});

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledWith({
      cfg: config,
      accountId: "work",
      channel: "discord",
      to: "channel:123",
      threadId: "456",
      childSessionKey: "agent:main:subagent:child",
      agentId: "main",
      label: "banana",
      boundBy: "system",
    });
    expect(result).toMatchObject({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "discord",
        accountId: "work",
        to: "channel:thread-1",
        sourceTo: "channel:123",
        threadId: "thread-1",
      },
    });
  });

  it("returns error when thread-bound subagent spawn is disabled", async () => {
    await expectSubagentSpawningError({
      config: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: false,
            },
          },
        },
      },
      errorContains: "spawnSessions=true",
    });
  });

  it("honors defaultAccount policy when requester omits accountId", async () => {
    const config = {
      channels: {
        discord: {
          defaultAccount: "work",
          threadBindings: {
            spawnSessions: true,
          },
          accounts: {
            work: {
              threadBindings: {
                spawnSessions: false,
              },
            },
          },
        },
      },
    };
    await expectSubagentSpawningError({
      config,
      event: createSpawnEvent({
        requester: {
          accountId: undefined,
          channel: "discord",
          to: "channel:123",
          threadId: undefined,
        },
      }),
      errorContains: "spawnSessions=true",
    });
    expect(hookMocks.resolveDiscordAccount).toHaveBeenCalledWith({
      cfg: config,
      accountId: undefined,
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
          discord: {
            threadBindings: {
              spawnSessions: true,
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
        discord: {
          accounts: {
            work: {
              threadBindings: {
                enabled: true,
                spawnSessions: true,
              },
            },
          },
        },
      },
    });

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "discord",
        accountId: "work",
        to: "channel:thread-1",
        threadId: "thread-1",
      },
    });
  });

  it("defaults thread-bound subagent spawn to enabled when unset", async () => {
    const result = await runSubagentSpawning({
      channels: {
        discord: {
          threadBindings: {},
        },
      },
    });

    expect(hookMocks.autoBindSpawnedDiscordSubagent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "ok",
      threadBindingReady: true,
      deliveryOrigin: {
        channel: "discord",
        accountId: "work",
        to: "channel:thread-1",
        threadId: "thread-1",
      },
    });
  });

  it("no-ops when thread binding is requested on non-discord channel", async () => {
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

    expect(hookMocks.autoBindSpawnedDiscordSubagent).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });

  it("returns error when thread bind fails", async () => {
    hookMocks.autoBindSpawnedDiscordSubagent.mockResolvedValueOnce(null);
    const result = await runSubagentSpawning();

    const errorResult = expectSubagentHookError(result);
    expect(errorResult.error).toMatch(/unable to create or bind/i);
  });

  it("unbinds thread routing on subagent_ended", async () => {
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_ended");

    await handler(
      {
        targetSessionKey: "agent:main:subagent:child",
        targetKind: "subagent",
        reason: "subagent-complete",
        sendFarewell: true,
        accountId: "work",
      },
      {},
    );

    expect(hookMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledTimes(1);
    expect(hookMocks.unbindThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
      reason: "subagent-complete",
      sendFarewell: true,
    });
  });

  it("tracks active Discord subagents with a count reaction and typing", async () => {
    vi.useFakeTimers();
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
            typing: {
              intervalMs: 100,
              maxDurationMs: 1_000,
            },
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "456",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-1",
        childSessionKey: "agent:main:subagent:child",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester,
      },
      {},
    );

    expect(hookMocks.reactMessageDiscord).toHaveBeenCalledWith("123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.sendTypingDiscord).toHaveBeenCalledWith("456", {
      cfg: expect.any(Object),
      accountId: "work",
    });

    await handleDiscordSubagentProgressEnded(
      {
        config: {
          channels: {
            discord: {
              subagentProgress: {
                enabled: true,
              },
            },
          },
        },
        logger: { debug: vi.fn() },
      },
      {
        runId: "run-1",
        outcome: "ok",
        requester,
      },
    );

    expect(hookMocks.removeReactionDiscord).toHaveBeenCalledWith("123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.reactMessageDiscord).toHaveBeenCalledTimes(1);
    const typingCallsAfterEnd = hookMocks.sendTypingDiscord.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(hookMocks.sendTypingDiscord).toHaveBeenCalledTimes(typingCallsAfterEnd);
  });

  it("targets subagent progress reactions at the source channel when typing targets a thread", async () => {
    vi.useFakeTimers();
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
            typing: {
              intervalMs: 100,
              maxDurationMs: 1_000,
            },
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:thread-1",
      sourceTo: "channel:123",
      threadId: "thread-1",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-thread-progress",
        childSessionKey: "agent:main:subagent:child-thread-progress",
        agentId: "main",
        mode: "run",
        threadRequested: true,
        requester,
      },
      {},
    );

    expect(hookMocks.reactMessageDiscord).toHaveBeenCalledWith("123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.sendTypingDiscord).toHaveBeenCalledWith("thread-1", {
      cfg: expect.any(Object),
      accountId: "work",
    });

    await handleDiscordSubagentProgressEnded(
      {
        config: {
          channels: {
            discord: {
              subagentProgress: {
                enabled: true,
              },
            },
          },
        },
        logger: { debug: vi.fn() },
      },
      {
        runId: "run-thread-progress",
        outcome: "error",
        requester,
      },
    );

    expect(hookMocks.removeReactionDiscord).toHaveBeenCalledWith("123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.reactMessageDiscord).toHaveBeenLastCalledWith("123", "msg-1", "🔴", {
      cfg: expect.any(Object),
      accountId: "work",
    });
  });

  it("cleans up persistent session progress from the internal progress-ended hook", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
            typing: {
              enabled: false,
            },
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "456",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-session",
        childSessionKey: "agent:main:subagent:session-child",
        agentId: "main",
        mode: "session",
        threadRequested: true,
        requester,
      },
      {},
    );
    await handleDiscordSubagentProgressEnded(
      {
        config: {
          channels: {
            discord: {
              subagentProgress: {
                enabled: true,
                typing: {
                  enabled: false,
                },
              },
            },
          },
        },
        logger: {
          debug: vi.fn(),
        },
      },
      {
        runId: "run-session",
        outcome: "ok",
        requester,
      },
    );

    expect(hookMocks.removeReactionDiscord).toHaveBeenCalledWith("123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.unbindThreadBindingsBySessionKey).not.toHaveBeenCalled();
  });

  it("reconstructs source-message cleanup when the in-memory tracker is missing", async () => {
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "456",
      messageId: "msg-1",
    };

    const handled = await handleDiscordSubagentProgressEnded(
      {
        config: {
          channels: {
            discord: {
              subagentProgress: {
                enabled: true,
                reactions: {
                  runningOrdinals: ["one", "two", "two"],
                  failure: "failed",
                },
              },
            },
          },
        },
        logger: { debug: vi.fn() },
      },
      {
        runId: "run-after-restart",
        outcome: "error",
        requester,
      },
    );

    expect(handled).toBe(true);
    expect(removeReactionDiscordEmojis()).toEqual(["one", "two"]);
    expect(hookMocks.reactMessageDiscord).toHaveBeenCalledWith("123", "msg-1", "failed", {
      cfg: expect.any(Object),
      accountId: "work",
    });
  });

  it("keeps missing-tracker cleanup retryable when reconstructed reaction cleanup fails", async () => {
    hookMocks.removeReactionDiscord.mockRejectedValueOnce(new Error("discord unavailable"));
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    const handled = await handleDiscordSubagentProgressEnded(
      {
        config: {
          channels: {
            discord: {
              subagentProgress: {
                enabled: true,
                reactions: {
                  runningOrdinals: ["one", "two"],
                  failure: "failed",
                },
              },
            },
          },
        },
        logger: { debug: vi.fn() },
      },
      {
        runId: "run-after-restart",
        outcome: "ok",
        requester,
      },
    );

    expect(handled).toBe(false);
    expect(removeReactionDiscordEmojis()).toEqual(["one", "two"]);
  });

  it("keeps tracked cleanup retryable when count reaction removal fails", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-retry-remove",
        childSessionKey: "agent:main:subagent:retry-remove",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester,
      },
      {},
    );
    hookMocks.removeReactionDiscord.mockRejectedValueOnce(new Error("discord unavailable"));

    const handled = await handleDiscordSubagentProgressEnded(
      {
        config: {
          channels: {
            discord: {
              subagentProgress: {
                enabled: true,
              },
            },
          },
        },
        logger: { debug: vi.fn() },
      },
      {
        runId: "run-retry-remove",
        outcome: "ok",
        requester,
      },
    );

    expect(handled).toBe(false);
    expect(hookMocks.removeReactionDiscord).toHaveBeenCalledWith("123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
  });

  it("keeps tracked cleanup retryable when count reaction add fails", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };
    const spawnRun = (runId: string) =>
      spawned(
        {
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          agentId: "main",
          mode: "run",
          threadRequested: false,
          requester,
        },
        {},
      );
    const endRun = (runId: string) =>
      handleDiscordSubagentProgressEnded(
        {
          config: {
            channels: {
              discord: {
                subagentProgress: {
                  enabled: true,
                },
              },
            },
          },
          logger: { debug: vi.fn() },
        },
        {
          runId,
          outcome: "ok",
          requester,
        },
      );

    for (const runId of ["run-1", "run-2", "run-3"]) {
      await spawnRun(runId);
    }
    hookMocks.reactMessageDiscord.mockRejectedValueOnce(new Error("discord unavailable"));

    const handled = await endRun("run-3");

    expect(handled).toBe(false);
    expect(hookMocks.removeReactionDiscord).toHaveBeenLastCalledWith("123", "msg-1", "3️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.reactMessageDiscord).toHaveBeenLastCalledWith("123", "msg-1", "2️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });

    await spawnRun("run-4");
    await endRun("run-4");

    expect(hookMocks.removeReactionDiscord).toHaveBeenLastCalledWith("123", "msg-1", "3️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.reactMessageDiscord).toHaveBeenLastCalledWith("123", "msg-1", "2️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
  });

  it("keeps tracked cleanup retryable when failure marker add fails", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-retry-failure-marker",
        childSessionKey: "agent:main:subagent:retry-failure-marker",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester,
      },
      {},
    );
    hookMocks.reactMessageDiscord.mockRejectedValueOnce(new Error("discord unavailable"));

    const handled = await handleDiscordSubagentProgressEnded(
      {
        config: {
          channels: {
            discord: {
              subagentProgress: {
                enabled: true,
              },
            },
          },
        },
        logger: { debug: vi.fn() },
      },
      {
        runId: "run-retry-failure-marker",
        outcome: "error",
        requester,
      },
    );

    expect(handled).toBe(false);
    expect(hookMocks.removeReactionDiscord).toHaveBeenCalledWith("123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.reactMessageDiscord).toHaveBeenLastCalledWith("123", "msg-1", "🔴", {
      cfg: expect.any(Object),
      accountId: "work",
    });
  });

  it("leaves a durable failure reaction when a Discord subagent ends non-ok", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-2",
        childSessionKey: "agent:main:subagent:child-2",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester,
      },
      {},
    );
    await handleDiscordSubagentProgressEnded(
      {
        config: {
          channels: {
            discord: {
              subagentProgress: {
                enabled: true,
              },
            },
          },
        },
        logger: { debug: vi.fn() },
      },
      {
        runId: "run-2",
        outcome: "error",
        requester,
      },
    );

    expect(hookMocks.removeReactionDiscord).toHaveBeenCalledWith("123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.reactMessageDiscord).toHaveBeenLastCalledWith("123", "msg-1", "🔴", {
      cfg: expect.any(Object),
      accountId: "work",
    });
  });

  it("replaces the Discord count reaction as active subagent count changes", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
            typing: {
              enabled: false,
            },
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };
    const spawnRun = (runId: string) =>
      spawned(
        {
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          agentId: "main",
          mode: "run",
          threadRequested: false,
          requester,
        },
        {},
      );
    const endRun = (runId: string, outcome = "ok") =>
      handleDiscordSubagentProgressEnded(
        {
          config: {
            channels: {
              discord: {
                subagentProgress: {
                  enabled: true,
                },
              },
            },
          },
          logger: { debug: vi.fn() },
        },
        {
          runId,
          outcome,
          requester,
        },
      );

    for (const runId of ["run-1", "run-2", "run-3"]) {
      await spawnRun(runId);
    }

    expect(reactMessageDiscordEmojis()).toEqual(["1️⃣", "2️⃣", "3️⃣"]);
    expect(removeReactionDiscordEmojis()).toEqual(["1️⃣", "2️⃣"]);

    await endRun("run-2", "error");
    await endRun("run-1");
    await endRun("run-3");

    expect(reactMessageDiscordEmojis()).toEqual(["1️⃣", "2️⃣", "3️⃣", "2️⃣", "🔴", "1️⃣"]);
    expect(removeReactionDiscordEmojis()).toEqual(["1️⃣", "2️⃣", "3️⃣", "2️⃣", "1️⃣"]);
  });

  it("does not track Discord subagent progress when disabled", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: false,
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const ended = getRequiredHookHandler(handlers, "subagent_ended");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-disabled",
        childSessionKey: "agent:main:subagent:child-disabled",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester,
      },
      {},
    );
    await ended(
      {
        targetSessionKey: "agent:main:subagent:child-disabled",
        targetKind: "subagent",
        reason: "subagent-complete",
        accountId: "work",
        runId: "run-disabled",
        outcome: "ok",
        requester,
      },
      {},
    );

    expect(hookMocks.reactMessageDiscord).not.toHaveBeenCalled();
    expect(hookMocks.removeReactionDiscord).not.toHaveBeenCalled();
    expect(hookMocks.sendTypingDiscord).not.toHaveBeenCalled();
  });

  it("does not track Discord subagent progress when config is missing", async () => {
    const handlers = registerHandlersForTest();
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const ended = getRequiredHookHandler(handlers, "subagent_ended");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-missing-config",
        childSessionKey: "agent:main:subagent:child-missing-config",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester,
      },
      {},
    );
    await ended(
      {
        targetSessionKey: "agent:main:subagent:child-missing-config",
        targetKind: "subagent",
        reason: "subagent-complete",
        accountId: "work",
        runId: "run-missing-config",
        outcome: "ok",
        requester,
      },
      {},
    );

    expect(hookMocks.reactMessageDiscord).not.toHaveBeenCalled();
    expect(hookMocks.removeReactionDiscord).not.toHaveBeenCalled();
    expect(hookMocks.sendTypingDiscord).not.toHaveBeenCalled();
  });

  it("does not track Discord subagent progress for disabled accounts", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          accounts: {
            work: {
              enabled: false,
            },
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const ended = getRequiredHookHandler(handlers, "subagent_ended");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-disabled-account",
        childSessionKey: "agent:main:subagent:child-disabled-account",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester,
      },
      {},
    );
    await ended(
      {
        targetSessionKey: "agent:main:subagent:child-disabled-account",
        targetKind: "subagent",
        reason: "subagent-complete",
        accountId: "work",
        runId: "run-disabled-account",
        outcome: "ok",
        requester,
      },
      {},
    );

    expect(hookMocks.reactMessageDiscord).not.toHaveBeenCalled();
    expect(hookMocks.removeReactionDiscord).not.toHaveBeenCalled();
    expect(hookMocks.sendTypingDiscord).not.toHaveBeenCalled();
  });

  it("keys Discord subagent progress by thread for typing cleanup", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
            reactions: {
              runningOrdinals: ["1️⃣"],
            },
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requesterBase = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    await spawned(
      {
        runId: "run-thread-a",
        childSessionKey: "agent:main:subagent:child-a",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester: { ...requesterBase, threadId: "456" },
      },
      {},
    );
    await spawned(
      {
        runId: "run-thread-b",
        childSessionKey: "agent:main:subagent:child-b",
        agentId: "main",
        mode: "run",
        threadRequested: false,
        requester: { ...requesterBase, threadId: "789" },
      },
      {},
    );

    expect(hookMocks.reactMessageDiscord).toHaveBeenCalledTimes(2);
    expect(hookMocks.reactMessageDiscord).toHaveBeenNthCalledWith(1, "123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.reactMessageDiscord).toHaveBeenNthCalledWith(2, "123", "msg-1", "1️⃣", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.sendTypingDiscord).toHaveBeenCalledWith("456", {
      cfg: expect.any(Object),
      accountId: "work",
    });
    expect(hookMocks.sendTypingDiscord).toHaveBeenCalledWith("789", {
      cfg: expect.any(Object),
      accountId: "work",
    });
  });

  it("caps the Discord count reaction at the configured ordinal list", async () => {
    const handlers = registerHandlersForTest({
      channels: {
        discord: {
          subagentProgress: {
            enabled: true,
            typing: {
              enabled: false,
            },
            reactions: {
              runningOrdinals: ["1️⃣", "2️⃣"],
            },
          },
        },
      },
    });
    const spawned = getRequiredHookHandler(handlers, "subagent_spawned");
    const requester = {
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      messageId: "msg-1",
    };

    for (const runId of ["run-1", "run-2", "run-3"]) {
      await spawned(
        {
          runId,
          childSessionKey: `agent:main:subagent:${runId}`,
          agentId: "main",
          mode: "run",
          threadRequested: false,
          requester,
        },
        {},
      );
    }

    expect(reactMessageDiscordEmojis()).toEqual(["1️⃣", "2️⃣"]);
    expect(removeReactionDiscordEmojis()).toEqual(["1️⃣"]);
  });

  it("resolves delivery target from matching bound thread", async () => {
    hookMocks.listThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", threadId: "777" },
    ]);
    const result = await resolveSubagentDeliveryTargetForTest({
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "777",
    });

    expect(hookMocks.listThreadBindingsBySessionKey).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
    });
    expect(result).toEqual({
      origin: {
        channel: "discord",
        accountId: "work",
        to: "channel:777",
        sourceTo: "channel:123",
        threadId: "777",
      },
    });
  });

  it("keeps original routing when delivery target is ambiguous", async () => {
    hookMocks.listThreadBindingsBySessionKey.mockReturnValueOnce([
      { accountId: "work", threadId: "777" },
      { accountId: "work", threadId: "888" },
    ]);
    const result = await resolveSubagentDeliveryTargetForTest({
      channel: "discord",
      accountId: "work",
      to: "channel:123",
    });

    expect(result).toBeUndefined();
  });
});

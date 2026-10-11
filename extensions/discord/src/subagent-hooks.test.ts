// Discord tests cover subagent hooks plugin behavior.
import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type ThreadBindingRecord = {
  accountId: string;
  threadId: string;
};

const hookMocks = vi.hoisted(() => {
  return {
    listThreadBindingsBySessionKeyAsync: vi.fn(
      async (_params?: unknown): Promise<ThreadBindingRecord[]> => [],
    ),
    unbindThreadBindingsBySessionKeyAsync: vi.fn(async () => []),
  };
});

let registerDiscordSubagentHooks: typeof import("../subagent-hooks-api.js").registerDiscordSubagentHooks;

vi.mock("./monitor/thread-bindings.js", () => ({
  listThreadBindingsBySessionKeyAsync: hookMocks.listThreadBindingsBySessionKeyAsync,
  unbindThreadBindingsBySessionKeyAsync: hookMocks.unbindThreadBindingsBySessionKeyAsync,
}));
function registerHandlersForTest() {
  return registerHookHandlersForTest<OpenClawPluginApi>({
    config: {},
    register: registerDiscordSubagentHooks,
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

describe("discord subagent hook handlers", () => {
  beforeAll(async () => {
    ({ registerDiscordSubagentHooks } = await import("../subagent-hooks-api.js"));
  });

  beforeEach(() => {
    hookMocks.listThreadBindingsBySessionKeyAsync.mockClear();
    hookMocks.unbindThreadBindingsBySessionKeyAsync.mockClear();
  });

  it("awaits thread routing removal on subagent_ended", async () => {
    const unbinding = createDeferred<void>();
    const unbindEntered = createDeferred<void>();
    hookMocks.unbindThreadBindingsBySessionKeyAsync.mockImplementationOnce(async () => {
      unbindEntered.resolve();
      await unbinding.promise;
      return [];
    });
    const handlers = registerHandlersForTest();
    const handler = getRequiredHookHandler(handlers, "subagent_ended");

    let settled = false;
    const ending = Promise.resolve(
      handler(
        {
          targetSessionKey: "agent:main:subagent:child",
          targetKind: "subagent",
          reason: "subagent-complete",
          sendFarewell: true,
          accountId: "work",
        },
        {},
      ),
    ).then(() => {
      settled = true;
    });

    try {
      await unbindEntered.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      unbinding.resolve();
      await ending;
    }
    expect(hookMocks.unbindThreadBindingsBySessionKeyAsync).toHaveBeenCalledTimes(1);
    expect(hookMocks.unbindThreadBindingsBySessionKeyAsync).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
      reason: "subagent-complete",
      sendFarewell: true,
    });
  });

  it("waits for cold binding restoration before routing a completion", async () => {
    const ready = createDeferred<ThreadBindingRecord[]>();
    const entered = createDeferred<void>();
    hookMocks.listThreadBindingsBySessionKeyAsync.mockImplementationOnce(() => {
      entered.resolve();
      return ready.promise;
    });
    let settled = false;
    const delivery = resolveSubagentDeliveryTargetForTest({
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "777",
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await entered.promise;
      await Promise.resolve();
      expect(settled).toBe(false);
    } finally {
      ready.resolve([{ accountId: "work", threadId: "777" }]);
      await delivery;
    }
    expect(await delivery).toEqual({
      origin: { channel: "discord", accountId: "work", to: "channel:777", threadId: "777" },
    });
  });

  it("does not restore Discord bindings for another channel's completion", async () => {
    expect(
      await resolveSubagentDeliveryTargetForTest({
        channel: "telegram",
        accountId: "work",
        to: "chat:123",
      }),
    ).toBeUndefined();
    expect(hookMocks.listThreadBindingsBySessionKeyAsync).not.toHaveBeenCalled();
  });

  it("resolves delivery target from matching bound thread", async () => {
    hookMocks.listThreadBindingsBySessionKeyAsync.mockResolvedValueOnce([
      { accountId: "work", threadId: "777" },
    ]);
    const result = await resolveSubagentDeliveryTargetForTest({
      channel: "discord",
      accountId: "work",
      to: "channel:123",
      threadId: "777",
    });

    expect(hookMocks.listThreadBindingsBySessionKeyAsync).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
    });
    expect(result).toEqual({
      origin: {
        channel: "discord",
        accountId: "work",
        to: "channel:777",
        threadId: "777",
      },
    });
  });

  it("keeps original routing when delivery target is ambiguous", async () => {
    hookMocks.listThreadBindingsBySessionKeyAsync.mockResolvedValueOnce([
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

import {
  getRequiredHookHandler,
  registerHookHandlersForTest,
} from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, expect, it, vi } from "vitest";
import { registerDiscordSubagentHooks } from "../subagent-hooks-api.js";

type Binding = { accountId: string; threadId: string };

const storage = vi.hoisted(() => ({
  list: vi.fn(async (_params?: unknown): Promise<Binding[]> => []),
  unbind: vi.fn(async (): Promise<Binding[]> => []),
}));

// mock-isolation: Keep persistent binding state outside the hook routing fixture.
vi.mock("./monitor/thread-bindings.js", () => ({
  listThreadBindingsBySessionKeyAsync: storage.list,
  unbindThreadBindingsBySessionKeyAsync: storage.unbind,
}));
const handlers = registerHookHandlersForTest<OpenClawPluginApi>({
  config: {},
  register: registerDiscordSubagentHooks,
});
const deliver = getRequiredHookHandler(handlers, "subagent_delivery_target");
const end = getRequiredHookHandler(handlers, "subagent_ended");

function deliveryTarget(overrides: { channel?: string; to?: string; threadId?: string } = {}) {
  return deliver(
    {
      childSessionKey: "agent:main:subagent:child",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "discord", accountId: "work", to: "channel:123", ...overrides },
      expectsCompletionMessage: true,
    },
    {},
  );
}

beforeEach(() => vi.clearAllMocks());

it.each(["subagent_ended", "subagent_delivery_target"])("awaits %s storage", async (name) => {
  const ready = createDeferred<Binding[]>();
  const entered = createDeferred<void>();
  const operationStorage = name === "subagent_ended" ? storage.unbind : storage.list;
  operationStorage.mockImplementationOnce(() => {
    entered.resolve();
    return ready.promise;
  });
  const event = {
    targetSessionKey: "agent:main:subagent:child",
    targetKind: "subagent",
    reason: "subagent-complete",
    sendFarewell: true,
    accountId: "work",
  };
  let settled = false;
  const operation = Promise.resolve(
    name === "subagent_ended" ? end(event, {}) : deliveryTarget({ threadId: "777" }),
  ).then((result) => {
    settled = true;
    return result;
  });
  try {
    await entered.promise;
    await Promise.resolve();
    expect(settled).toBe(false);
  } finally {
    ready.resolve(name === "subagent_ended" ? [] : [{ accountId: "work", threadId: "777" }]);
    await operation;
  }
  if (name === "subagent_ended") {
    expect(operationStorage).toHaveBeenCalledExactlyOnceWith(event);
  } else {
    expect(await operation).toEqual({
      origin: { channel: "discord", accountId: "work", to: "channel:777", threadId: "777" },
    });
    expect(operationStorage).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:subagent:child",
      accountId: "work",
      targetKind: "subagent",
    });
  }
});

it("does not restore Discord bindings for another channel's completion", async () => {
  expect(await deliveryTarget({ channel: "telegram", to: "chat:123" })).toBeUndefined();
  expect(storage.list).not.toHaveBeenCalled();
});

it("keeps original routing when delivery target is ambiguous", async () => {
  storage.list.mockResolvedValueOnce([
    { accountId: "work", threadId: "777" },
    { accountId: "work", threadId: "888" },
  ]);
  expect(await deliveryTarget()).toBeUndefined();
});

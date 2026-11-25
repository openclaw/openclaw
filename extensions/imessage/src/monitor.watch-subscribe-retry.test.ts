import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { waitForTransportReady as WaitForReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { createIMessageRpcClient, IMessageRpcClient } from "./client.js";
import type { attachIMessageMonitorAbortHandler } from "./monitor/abort-handler.js";
import { monitorIMessageProvider } from "./monitor/monitor-provider.js";
import { rememberPersistedIMessageEcho } from "./monitor/persisted-echo-cache.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./monitor/types.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitUntilReady = vi.hoisted(() => vi.fn<typeof WaitForReady>(async () => {}));
const createClient = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const attachAbortHandler = vi.hoisted(() =>
  vi.fn<typeof attachIMessageMonitorAbortHandler>(() => () => {}),
);

// mock-isolation: Readiness is fixture-controlled; no installed Messages transport is probed.
vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitUntilReady,
}));

// mock-isolation: Retry scenarios use fixture RPC notifications, never the user's Messages store.
vi.mock("./client.js", () => ({ createIMessageRpcClient: createClient }));

// mock-isolation: Abort cleanup is owned by each fixture client instead of a live transport listener.
vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: attachAbortHandler,
}));

type MockIMessageRpcClient = IMessageRpcClient & {
  request: ReturnType<typeof vi.fn<(method: string) => Promise<unknown>>>;
  waitForClose: ReturnType<typeof vi.fn<() => Promise<void>>>;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
};

function createRpcClient(overrides?: {
  request?: (method: string) => Promise<unknown>;
  waitForClose?: () => Promise<void>;
}): MockIMessageRpcClient {
  return {
    request: vi.fn(overrides?.request ?? (async () => ({ subscription: 1 }))),
    waitForClose: vi.fn(overrides?.waitForClose ?? (async () => {})),
    stop: vi.fn(async () => {}),
  } as unknown as MockIMessageRpcClient;
}

function runMonitor(options: Partial<MonitorIMessageOpts> = {}) {
  return monitorIMessageProvider({
    scheduler: createTestPluginServiceScheduler(),
    config: { channels: { imessage: {} } },
    runtime: createRuntimeSpies(),
    ...options,
  });
}

async function monitorMessages(messages: IMessagePayload[], config: MonitorIMessageOpts["config"]) {
  const runtime = createRuntimeSpies();
  createClient.mockImplementation(async (params) =>
    createRpcClient({
      waitForClose: async () => {
        for (const message of messages) {
          params?.onNotification?.({ method: "message", params: { message } });
          await Promise.resolve();
        }
        await Promise.resolve();
        await Promise.resolve();
      },
    }),
  );
  await runMonitor({ config, runtime });
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  return runtime;
}

function groupMessage(id: number, overrides: Partial<IMessagePayload> = {}): IMessagePayload {
  return {
    id,
    guid: `p:0/message-${id}`,
    chat_id: 456,
    sender: "+15550001111",
    is_from_me: false,
    is_group: true,
    text: "private message text",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  installIMessageStateRuntimeForTest();
  waitUntilReady.mockReset().mockResolvedValue(undefined);
  createClient.mockReset();
  attachAbortHandler.mockReset().mockReturnValue(() => {});
});

afterEach(() => vi.useRealTimers());

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/transport-ready-runtime");
  vi.doUnmock("./client.js");
  vi.doUnmock("./monitor/abort-handler.js");
  vi.resetModules();
});

it.each([false, true])("retries startup timeouts with bounded failure: %s", async (exhausted) => {
  const statusSink = vi.fn();
  const firstSubscribe = createDeferred<void>();
  const failSubscribe = () =>
    createRpcClient({
      request: async () => {
        firstSubscribe.resolve();
        throw new Error("imsg rpc timeout (watch.subscribe)");
      },
    });
  const failingClient = failSubscribe();
  const readyClient = createRpcClient();
  createClient.mockImplementation(async () => (exhausted ? failSubscribe() : readyClient));
  createClient.mockResolvedValueOnce(failingClient);
  const monitorPromise = runMonitor({ statusSink }).catch((error: unknown) => error);

  await Promise.race([firstSubscribe.promise, monitorPromise]);
  await vi.advanceTimersByTimeAsync(exhausted ? 2_000 : 1_000);
  const error = await monitorPromise;
  const states = statusSink.mock.calls.map(([state]) => state);
  expect(states.at(-1)).toMatchObject(
    exhausted
      ? { lifecycle: "recovering", terminalDisconnect: undefined }
      : { lifecycle: "ready", connected: true, terminalDisconnect: undefined },
  );
  expect(states).not.toContainEqual(expect.objectContaining({ lifecycle: "blocked" }));
  expect(createClient).toHaveBeenCalledTimes(exhausted ? 3 : 2);

  if (exhausted) {
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("imsg rpc timeout (watch.subscribe)");
    return;
  }
  expect(error).toBeUndefined();

  expect(failingClient.stop).toHaveBeenCalledTimes(1);
  expect(readyClient.waitForClose).toHaveBeenCalledTimes(1);
  expect(readyClient.stop).toHaveBeenCalledTimes(1);
  expect(states[0]).toMatchObject({ lifecycle: "recovering", connected: false });
});

it("publishes blocked for a non-retriable watch.subscribe failure", async () => {
  const statusSink = vi.fn();
  createClient.mockResolvedValueOnce(
    createRpcClient({
      request: async () => {
        throw new Error("permission denied");
      },
    }),
  );

  await expect(runMonitor({ statusSink })).rejects.toThrow("permission denied");

  expect(createClient).toHaveBeenCalledOnce();
  expect(statusSink).toHaveBeenCalledWith(
    expect.objectContaining({ lifecycle: "blocked", terminalDisconnect: true }),
  );
});

it.each(["from me", "no mention"])("logs one diagnostic per chat for %s drops", async (reason) => {
  vi.useRealTimers();
  installIMessageStateRuntimeForTest();
  const messages = (
    [
      [43, 456],
      [44, 456],
      [45, 457],
    ] as const
  ).map(([id, chat_id]) =>
    groupMessage(id, {
      chat_id,
      guid: `p:0/private-${reason}-${id}`,
      is_from_me: reason === "from me",
    }),
  );

  const runtime = await monitorMessages(messages, {
    agents: { entries: { main: { identity: { name: "Claw" } } } },
    channels: {
      imessage: {
        dmPolicy: "open",
        groupPolicy: "allowlist",
        groupAllowFrom: ["+15550001111"],
        groups: { "*": { requireMention: true } },
        accounts: { default: {} },
      },
    },
  });
  expect(runtime.error.mock.calls).toEqual([]);
  const diagnostics = runtime.log.mock.calls.map(([message]) => String(message));
  expect(diagnostics).toEqual([
    expect.stringContaining(`reason="${reason}"`),
    expect.stringContaining(`reason="${reason}"`),
  ]);
  expect(diagnostics[1]).toContain("chat_id=457");
  expect(diagnostics[0]).toContain("chat_id=456");
  expect(diagnostics[0]).not.toContain("p:0/private-");
  expect(diagnostics[0]).not.toContain("private message text");
  expect(diagnostics[0]).not.toContain("+15550001111");
  if (reason === "no mention") {
    expect(diagnostics[0]).toContain("identity");
    expect(diagnostics[0]).toContain('channels.imessage.groups["456"].requireMention=false');
  }
});

it("redacts the conversation identifier in rate-limit suppression warnings", async () => {
  vi.useRealTimers();
  installIMessageStateRuntimeForTest();
  const sender = "+15550002222";
  const chatId = 456;
  const scope = `default:chat_id:${chatId}`;
  await rememberPersistedIMessageEcho({ scope, text: "loop echo" });
  const messages = Array.from({ length: 5 }, (_, i) =>
    groupMessage(i + 1, { sender, text: "loop echo" }),
  );
  messages.push(groupMessage(6, { sender, text: "legitimate inbound" }));
  const runtime = await monitorMessages(messages, {
    channels: { imessage: { groupPolicy: "open" } },
  });
  const logs = runtime.log.mock.calls.map(([message]) => String(message));
  const warning = logs.find((message) => message.includes("rate limiter tripped"));
  expect(warning).toContain(`group:${redactIdentifier(`group:${chatId}`)}`);
  expect(warning).not.toContain(sender);
});

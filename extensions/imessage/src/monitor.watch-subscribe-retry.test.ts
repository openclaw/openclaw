import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { redactIdentifier } from "openclaw/plugin-sdk/logging-core";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import type { createIMessageRpcClient, IMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import type { attachIMessageMonitorAbortHandler } from "./monitor/abort-handler.js";
import { rememberPersistedIMessageEcho } from "./monitor/persisted-echo-cache.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./monitor/types.js";
import {
  installIMessageFailingStateRuntimeForTest,
  installIMessageStateRuntimeForTest,
} from "./test-support/runtime.js";

const waitReady = vi.hoisted(() => vi.fn<typeof waitForTransportReady>());
const createClient = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const attachAbort = vi.hoisted(() => vi.fn<typeof attachIMessageMonitorAbortHandler>());

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitReady,
}));

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createClient,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: attachAbort,
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

function subscribeFailure(message: string, entered?: () => void) {
  return createRpcClient({
    request: async () => {
      entered?.();
      throw new Error(message);
    },
  });
}

function arrangeMessages(messages: IMessagePayload[], afterNotify = async () => {}) {
  createClient.mockImplementation(async (params) =>
    createRpcClient({
      waitForClose: async () => {
        for (const message of messages) {
          await params?.onNotification?.({
            method: "message",
            params: {
              message: {
                sender: "+15550001111",
                is_from_me: false,
                is_group: true,
                created_at: new Date().toISOString(),
                ...message,
              },
            },
          });
        }
        await afterNotify();
      },
    }),
  );
}

function runMonitor(
  runtime = createRuntimeSpies(),
  statusSink?: MonitorIMessageOpts["statusSink"],
  config: MonitorIMessageOpts["config"] = { channels: { imessage: {} } },
) {
  return monitorIMessageProvider({
    scheduler: createTestPluginServiceScheduler(),
    config,
    runtime,
    statusSink,
  });
}

describe("monitorIMessageProvider watch.subscribe startup retry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    installIMessageFailingStateRuntimeForTest();
    waitReady.mockReset().mockResolvedValue(undefined);
    createClient.mockReset();
    attachAbort.mockReset().mockReturnValue(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/transport-ready-runtime");
    vi.doUnmock("./client.js");
    vi.doUnmock("./monitor/abort-handler.js");
    vi.resetModules();
  });

  it.each([true, false])(
    "settles bounded transient startup retries (recovers: %s)",
    async (recovers) => {
      const runtime = createRuntimeSpies();
      const statusSink = vi.fn();
      const firstSubscribe = createDeferred<void>();
      const timeout = "imsg rpc timeout (watch.subscribe)";
      const firstClient = subscribeFailure(timeout, firstSubscribe.resolve);
      const secondClient = createRpcClient();
      if (!recovers) {
        createClient.mockImplementation(async () => subscribeFailure(timeout));
      }
      createClient.mockResolvedValueOnce(firstClient);
      if (recovers) {
        createClient.mockResolvedValueOnce(secondClient);
      }
      const monitorPromise = runMonitor(runtime, statusSink).catch((error: unknown) => error);
      await Promise.race([firstSubscribe.promise, monitorPromise]);
      await vi.advanceTimersByTimeAsync(recovers ? 1_000 : 2_000);
      const outcome = await monitorPromise;

      if (!recovers) {
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain(timeout);
        expect(createClient).toHaveBeenCalledTimes(3);
        expect(runtime.error).toHaveBeenCalledTimes(1);
        const failureLog = String(runtime.error.mock.calls[0]?.[0]);
        expect(failureLog).toContain(
          "imessage: monitor failed: imessage: watch.subscribe startup failed attempt=3/3 account=default",
        );
        expect(failureLog).toContain("timeoutMs=10000");
        expect(failureLog).toContain(`Error: ${timeout}`);
        expect(statusSink).toHaveBeenLastCalledWith(
          expect.objectContaining({ lifecycle: "recovering", terminalDisconnect: undefined }),
        );
        expect(statusSink).not.toHaveBeenCalledWith(
          expect.objectContaining({ lifecycle: "blocked" }),
        );
        return;
      }

      expect(outcome).toBeUndefined();
      expect(createClient).toHaveBeenCalledTimes(2);
      for (const mock of [firstClient.stop, secondClient.waitForClose, secondClient.stop]) {
        expect(mock).toHaveBeenCalledOnce();
      }
      expect(statusSink.mock.calls.slice(0, 2).map(([status]) => status)).toMatchObject([
        { lifecycle: "recovering", connected: false },
        { lifecycle: "ready", connected: true, terminalDisconnect: undefined },
      ]);
      expect(secondClient.request).toHaveBeenCalledWith(
        "watch.subscribe",
        { attachments: false, include_reactions: true },
        { timeoutMs: 10_000 },
      );
      expect(runtime.log).toHaveBeenCalledTimes(1);
      const retryLog = String(runtime.log.mock.calls[0]?.[0]);
      expect(retryLog).toContain(
        "imessage: watch.subscribe startup failed attempt=1/3 account=default cliPath=imsg dbPath=default",
      );
      expect(retryLog).toContain("timeoutMs=10000 since_rowid=none attachments=false");
      expect(retryLog).toContain("retry_in_ms=1000: Error: imsg rpc timeout (watch.subscribe)");
      expect(runtime.error.mock.calls.map(([message]) => String(message)).join("\n")).not.toContain(
        "imessage: monitor failed",
      );
    },
  );

  it("publishes blocked for a non-retriable watch.subscribe failure", async () => {
    const statusSink = vi.fn();
    createClient.mockResolvedValueOnce(subscribeFailure("permission denied"));

    await expect(runMonitor(undefined, statusSink)).rejects.toThrow("permission denied");

    expect(createClient).toHaveBeenCalledOnce();
    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "blocked", terminalDisconnect: true }),
    );
  });

  it.each(["from me", "no mention"])(
    "logs one diagnostic per chat for %s drops",
    async (reason) => {
      vi.useRealTimers();
      installIMessageStateRuntimeForTest();
      const runtime = createRuntimeSpies();
      const runId = Date.now();
      arrangeMessages(
        (
          [
            [43, 456, `p:0/outbound-guid-${runId}`],
            [44, 456, `p:0/second-outbound-guid-${runId}`],
            [45, 457, `p:0/other-chat-guid-${runId}`],
          ] as const
        ).map(([id, chat_id, guid]) => ({
          id,
          chat_id,
          guid,
          is_from_me: reason === "from me",
          text: "private message text",
        })),
        async () => {
          await Promise.resolve();
          await Promise.resolve();
        },
      );

      await runMonitor(runtime, undefined, {
        agents: { entries: { main: { identity: { name: "Claw" } } } },
        channels: {
          imessage: {
            dmPolicy: "open",
            groupPolicy: "allowlist",
            groupAllowFrom: ["+15550001111"],
            groups:
              reason === "no mention"
                ? {
                    "*": { requireMention: true },
                    "999": { requireMention: false, tools: { deny: ["exec"] } },
                  }
                : undefined,
            accounts: reason === "no mention" ? { default: {} } : undefined,
          },
        },
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(runtime.error.mock.calls).toEqual([]);
      const diagnostics = runtime.log.mock.calls.map(([message]) => String(message));
      expect(diagnostics).toEqual([
        expect.stringContaining(`reason="${reason}"`),
        expect.stringContaining(`reason="${reason}"`),
      ]);
      expect(diagnostics[1]).toContain("chat_id=457");
      expect(diagnostics[0]).toContain(
        `account=default reason="${reason}" chat_id=456 group=true message_id=43 guid=present`,
      );
      for (const secret of ["outbound-guid", "private message text", "+15550001111"]) {
        expect(diagnostics[0]).not.toContain(secret);
      }
      if (reason === "no mention") {
        expect(diagnostics[0]).toContain("identity");
        expect(diagnostics[0]).toContain('channels.imessage.groups["456"].requireMention=false');
      }
    },
  );

  it("redacts the conversation identifier in rate-limit suppression warnings", async () => {
    vi.useRealTimers();
    installIMessageStateRuntimeForTest();
    const runtime = createRuntimeSpies();
    const sender = "+15550002222";
    const chatId = 456;
    const scope = `default:chat_id:${chatId}`;
    await rememberPersistedIMessageEcho({ scope, text: "loop echo" });
    arrangeMessages(
      Array.from({ length: 6 }, (_, index) => ({
        id: index + 1,
        guid: `p:0/message-${index + 1}`,
        chat_id: chatId,
        sender,
        text: index < 5 ? "loop echo" : "legitimate inbound",
      })),
    );

    await runMonitor(runtime, undefined, { channels: { imessage: { groupPolicy: "open" } } });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const logs = runtime.log.mock.calls.map(([message]) => String(message));
    const warning = logs.find((message) => message.includes("rate limiter tripped"));
    expect(warning, `logs: ${JSON.stringify(logs)}`).toBeDefined();
    expect(warning).toContain(`group:${redactIdentifier(`group:${chatId}`)}`);
    expect(warning).not.toContain(sender);
  });
});

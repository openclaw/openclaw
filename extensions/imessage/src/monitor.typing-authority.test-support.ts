import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  observeHostDataSql,
  openIncognitoTestActor,
  withIncognitoSessionBinding,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it, vi, type Mock } from "vitest";
import type { IMessageRpcClient } from "./client.js";
import { DEFAULT_SENDER } from "./monitor.last-route.test-support.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./monitor/types.js";
import type { probeIMessagePrivateApi } from "./probe.js";

type WatchParams = {
  requests?: Record<string, RequestResult>;
  auxiliaryRequests: Record<string, RequestResult>;
  message: IMessagePayload;
  afterNotify?: () => Promise<void>;
};
type RequestResult =
  | Record<string, unknown>
  | ((params?: Parameters<IMessageRpcClient["request"]>[1]) => unknown);
type TestRequest = (...args: Parameters<IMessageRpcClient["request"]>) => Promise<unknown>;
type WatchClient = { request: TestRequest; auxiliaryClient?: { request: TestRequest } };

// Register against the shared monitor fixture so native and actor cases use the same ingress.
export function registerIMessageTypingAuthorityTests({
  createTestStateDir,
  createIMessageWatchClient,
  createInboundMessage,
  runIMessageMonitor,
  runMessageCase,
  setAvailablePrivateApiMethods,
  probeIMessagePrivateApiMock,
  dispatchReplyWithBufferedBlockDispatcherMock,
}: {
  createTestStateDir: (prefix: string) => string;
  createIMessageWatchClient: (params: WatchParams) => WatchClient;
  createInboundMessage: (message: { id: number; guid: string; text: string }) => IMessagePayload;
  runIMessageMonitor: (params: {
    session?: { store: string };
    imessage: { sendReadReceipts: boolean };
    runtime?: MonitorIMessageOpts["runtime"];
  }) => Promise<void>;
  runMessageCase: (params: WatchParams) => Promise<WatchClient>;
  setAvailablePrivateApiMethods: (rpcMethods: string[]) => void;
  probeIMessagePrivateApiMock: Mock<typeof probeIMessagePrivateApi>;
  dispatchReplyWithBufferedBlockDispatcherMock: Mock<
    typeof dispatchReplyWithBufferedBlockDispatcher
  >;
}): void {
  const EMPTY_DISPATCH_RESULT = {
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  } as const;
  it("starts direct typing before dispatching the inbound turn", async ({ signal }) => {
    setAvailablePrivateApiMethods(["watch.subscribe", "send", "typing"]);
    const typingCompleted = createDeferred<{ ok: true }>();
    const typingStopped = createDeferred<void>();
    const dispatchEntered = createDeferred<void>();
    const watchClient = createIMessageWatchClient({
      requests: {
        "watch.subscribe": { subscription: 1 },
        typing: { ok: true },
      },
      auxiliaryRequests: {
        typing: (params) => {
          if (params?.typing === true) {
            return typingCompleted.promise;
          }
          typingStopped.resolve();
          return { ok: true };
        },
      },
      message: createInboundMessage({
        id: 12,
        guid: "typing-early-guid-12",
        text: "respond after a slow context build",
      }),
      afterNotify: async () => {
        try {
          await withinTest(dispatchEntered.promise, signal);
          expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
        } finally {
          typingCompleted.resolve({ ok: true });
        }
      },
    });
    const earlyTypingClient = watchClient.auxiliaryClient!;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async () => {
      dispatchEntered.resolve();
      expect(earlyTypingClient.request).toHaveBeenCalledWith(
        "typing",
        expect.objectContaining({ typing: true, to: "+15550001111" }),
        expect.any(Object),
      );
      return EMPTY_DISPATCH_RESULT;
    });

    await runIMessageMonitor({ imessage: { sendReadReceipts: false } });

    expect(watchClient.request).not.toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ typing: true }),
      expect.anything(),
    );
    await withinTest(typingStopped.promise, signal);
    expect(earlyTypingClient.request).toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ typing: false, to: "+15550001111" }),
      expect.any(Object),
    );
  });

  it("does not wait for read receipts before dispatching the inbound turn", async ({ signal }) => {
    setAvailablePrivateApiMethods(["watch.subscribe", "read"]);
    const readCompleted = createDeferred<{ ok: true }>();
    const dispatchEntered = createDeferred<void>();
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementationOnce(async () => {
      dispatchEntered.resolve();
      return EMPTY_DISPATCH_RESULT;
    });
    const watchClient = await runMessageCase({
      auxiliaryRequests: { read: () => readCompleted.promise },
      message: createInboundMessage({
        id: 11,
        guid: "read-receipt-guid-11",
        text: "respond without waiting for read receipt",
      }),
      afterNotify: async () => {
        try {
          await withinTest(dispatchEntered.promise, signal);
          expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
        } finally {
          readCompleted.resolve({ ok: true });
        }
      },
    });
    const readClient = watchClient.auxiliaryClient!;

    expect(readClient.request).toHaveBeenCalledWith(
      "read",
      expect.objectContaining({ chat_id: 123 }),
      expect.any(Object),
    );
    expect(watchClient.request).not.toHaveBeenCalledWith(
      "read",
      expect.anything(),
      expect.anything(),
    );
    expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
  });

  it.each(["live", "policy changed", "actor retired"] as const)(
    "retains the bound actor's typing authority across the private API probe: %s",
    async (change) => {
      const env = { OPENCLAW_STATE_DIR: createTestStateDir("imessage-bound-typing-") };
      const authority = { assertCurrent() {} };
      const actor = await openIncognitoTestActor(env, authority);
      const sessionKey = "agent:main:dashboard:incognito-imessage";
      const entry = { sessionId: "private-imessage", updatedAt: 1, sendPolicy: "allow" as const };
      const binding: SessionBindingRecord = {
        bindingId: "imessage-bound-typing",
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation: {
          channel: "imessage",
          accountId: "default",
          conversationId: DEFAULT_SENDER,
        },
        status: "active",
        boundAt: 1,
      };
      let sourceSql: ReturnType<typeof observeHostDataSql> | undefined;
      const adapter = {
        channel: "imessage",
        accountId: "default",
        listBySession: () => [binding],
        resolveByConversation: () => binding,
        inspectByConversationAsync: async () => binding,
        touchAsync: async () => {
          sourceSql ??= observeHostDataSql();
        },
      };
      const probeEntered = createDeferred<void>();
      const releaseProbe = createDeferred<void>();
      const settled = createDeferred<void>();
      const runtime = {
        error: vi.fn(() => settled.resolve()),
        exit: vi.fn(),
        log: vi.fn(),
      };
      probeIMessagePrivateApiMock.mockImplementation(async () => {
        sourceSql?.restore();
        probeEntered.resolve();
        await releaseProbe.promise;
        return {
          available: true,
          v2Ready: true,
          selectors: {},
          rpcMethods: ["watch.subscribe", "typing"],
        };
      });
      const watchClient = createIMessageWatchClient({
        auxiliaryRequests: { typing: { ok: true } },
        message: createInboundMessage({
          id: 15,
          guid: `bound-typing-${change}`,
          text: "respond on the bound session",
        }),
        afterNotify: async () => {
          try {
            expect(
              await Promise.race([
                probeEntered.promise.then(() => "probe"),
                settled.promise.then(() => "settled"),
              ]),
            ).toBe("probe");
            expect(sourceSql?.queries).toEqual([]);
            if (change === "policy changed") {
              await upsertSessionEntry({
                agentId: "main",
                storePath: actor.path,
                sessionKey,
                entry: { ...entry, sendPolicy: "deny" },
              });
            } else if (change === "actor retired") {
              await actor.close();
            }
          } finally {
            releaseProbe.resolve();
          }
          await settled.promise;
        },
      });
      const previousDispatch = dispatchReplyWithBufferedBlockDispatcherMock.getMockImplementation();
      dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(async (params) => {
        expect(params.ctx.SessionKey).toBe(sessionKey);
        expect(watchClient.auxiliaryClient?.request).toHaveBeenCalledWith(
          "typing",
          expect.objectContaining({ typing: true, to: DEFAULT_SENDER }),
          expect.any(Object),
        );
        settled.resolve();
        return EMPTY_DISPATCH_RESULT;
      });
      registerSessionBindingAdapter(adapter);
      try {
        await actor.sessions.create(authority, { sessionKey, entry });
        await withIncognitoSessionBinding({ actor }, async () => {
          await runIMessageMonitor({
            session: { store: actor.path },
            imessage: { sendReadReceipts: false },
            runtime,
          });
        });
        if (change === "live") {
          expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledOnce();
          expect(runtime.error).not.toHaveBeenCalled();
        } else {
          expect(watchClient.auxiliaryClient?.request).not.toHaveBeenCalled();
          expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
          expect(runtime.error).toHaveBeenCalledWith(
            expect.stringContaining("imessage: inbound dispatch failed:"),
          );
        }
      } finally {
        dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
          previousDispatch ?? (async () => EMPTY_DISPATCH_RESULT),
        );
        releaseProbe.resolve();
        sourceSql?.restore();
        unregisterSessionBindingAdapter({ channel: "imessage", accountId: "default", adapter });
        await actor.close();
      }
    },
  );

  it("re-probes missing private API capabilities before typing and read receipts", async () => {
    probeIMessagePrivateApiMock.mockResolvedValue({
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods: ["watch.subscribe", "typing", "read"],
    });
    const client = await runMessageCase({
      auxiliaryRequests: {
        typing: { ok: true },
        read: { ok: true },
      },
      message: createInboundMessage({
        id: 14,
        guid: "private-api-refresh-guid-14",
        text: "restore native feedback after bridge recovery",
      }),
    });
    const auxiliaryClient = client.auxiliaryClient!;

    expect(probeIMessagePrivateApiMock).toHaveBeenCalledWith("imsg", 10_000);
    expect(auxiliaryClient.request).toHaveBeenCalledWith(
      "read",
      expect.objectContaining({ chat_id: 123 }),
      expect.any(Object),
    );
    expect(auxiliaryClient.request).toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ typing: true }),
      expect.any(Object),
    );
  });
}

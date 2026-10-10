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
import { expect, it, vi, type Mock } from "vitest";
import { DEFAULT_SENDER } from "./monitor.last-route.test-support.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./monitor/types.js";
import type { probeIMessagePrivateApi } from "./probe.js";

type WatchParams = {
  auxiliaryRequests: Record<string, { ok: boolean }>;
  message: IMessagePayload;
  afterNotify?: () => Promise<void>;
};
type WatchClient = { auxiliaryClient?: { request: unknown } };

// Register against the shared monitor fixture so native and actor cases use the same ingress.
export function registerIMessageTypingAuthorityTests({
  createTestStateDir,
  createIMessageWatchClient,
  createInboundMessage,
  runIMessageMonitor,
  runMessageCase,
  probeIMessagePrivateApiMock,
  dispatchReplyWithBufferedBlockDispatcherMock,
}: {
  createTestStateDir: (prefix: string) => string;
  createIMessageWatchClient: (params: WatchParams) => WatchClient;
  createInboundMessage: (message: { id: number; guid: string; text: string }) => IMessagePayload;
  runIMessageMonitor: (params: {
    session: { store: string };
    imessage: { sendReadReceipts: boolean };
    runtime: MonitorIMessageOpts["runtime"];
  }) => Promise<void>;
  runMessageCase: (params: WatchParams) => Promise<WatchClient>;
  probeIMessagePrivateApiMock: Mock<typeof probeIMessagePrivateApi>;
  dispatchReplyWithBufferedBlockDispatcherMock: Mock<
    typeof dispatchReplyWithBufferedBlockDispatcher
  >;
}): void {
  const EMPTY_DISPATCH_RESULT = {
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  } as const;
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

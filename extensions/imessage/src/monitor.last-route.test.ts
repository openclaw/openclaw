import path from "node:path";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ensureConfiguredBindingRouteReady } from "openclaw/plugin-sdk/conversation-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createTypingController } from "openclaw/plugin-sdk/reply-payload-testing";
import type { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { imessagePlugin } from "./channel.js";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import {
  createChatDb,
  createChatDbMessage,
  DEFAULT_SENDER,
  insertChatDbMessage,
  readChatDbMessagesAfter,
  runInboundWithDispatch,
  withChatDb,
} from "./monitor.last-route.test-support.js";
import * as iMessageMediaStaging from "./monitor/media-staging.js";
import {
  advanceIMessageRecoveryCursor,
  loadIMessageRecoveryCursor,
  resolveIMessageRecoveryCursorDbIdentity,
} from "./monitor/recovery-cursor.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./monitor/types.js";
import {
  getCachedIMessagePrivateApiStatus,
  setCachedIMessagePrivateApiStatus,
} from "./private-api-status.js";
import type { probeIMessagePrivateApi } from "./probe.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const ANCHOR_REPAIR_GUID = "11111111-1111-4111-8111-111111111111";
const WATCH_SUBSCRIBE_PARAMS = { attachments: false, include_reactions: true } as const;
const WATCH_SUBSCRIBE_OPTIONS = { timeoutMs: 10_000 } as const;
const UNAVAILABLE_API = { available: false, v2Ready: false, selectors: {}, rpcMethods: [] };
const EMPTY_DISPATCH_RESULT = {
  queuedFinal: false,
  counts: { tool: 0, block: 0, final: 0 },
} as const;
const ATTACHMENT_ROOT = "/Users/openclaw/Library/Messages/Attachments";
const PDF_PATH = `${ATTACHMENT_ROOT}/report.pdf`;
const MISSING_IMAGE = {
  original_path: `${ATTACHMENT_ROOT}/missing.heic`,
  mime_type: "image/heic",
  missing: true,
};
const STAGED_MISSING_IMAGE = { contentType: "image/heic", kind: "image" as const };
const PDF = { original_path: PDF_PATH, mime_type: "application/pdf", missing: false };
const STAGED_PDF = { path: PDF_PATH, contentType: "application/pdf", kind: "document" as const };

type IMessageTestRequest = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type IMessageTestRequestResult =
  | Record<string, unknown>
  | ((params?: Record<string, unknown>) => unknown);
type MonitorRunParams = {
  accountId?: string;
  imessage?: Record<string, unknown>;
  session?: Record<string, unknown>;
  messages?: Record<string, unknown>;
  agents?: Record<string, unknown>;
  bindings?: OpenClawConfig["bindings"];
  runtime?: MonitorIMessageOpts["runtime"];
  allowlist?: boolean;
};
type WatchClientParams = {
  requests?: Record<string, IMessageTestRequestResult>;
  auxiliaryRequests?: Record<string, IMessageTestRequestResult>;
  message?: IMessagePayload;
  messages?: IMessagePayload[];
  onClose?: (notify: (message: IMessagePayload) => void) => Promise<void>;
  afterNotify?: () => Promise<void>;
};

function expectRpc(
  client: { request: ReturnType<typeof vi.fn> },
  method: string,
  params: Record<string, unknown>,
) {
  expect(client.request).toHaveBeenCalledWith(
    method,
    expect.objectContaining(params),
    expect.any(Object),
  );
}

async function expectDispatches(count = 1) {
  await vi.waitFor(() => expect(dispatchMock).toHaveBeenCalledTimes(count));
}

function createIMessageTestRequest(
  results: Record<string, IMessageTestRequestResult>,
): IMessageTestRequest {
  return async (method, params) => {
    if (!Object.hasOwn(results, method)) {
      throw new Error(`unexpected imsg method ${method}`);
    }
    const result = results[method];
    return typeof result === "function" ? await result(params) : result;
  };
}

async function settleNotifications(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function expireCachedPrivateApiStatus(): void {
  setCachedIMessagePrivateApiStatus("imsg", UNAVAILABLE_API, 1);
  getCachedIMessagePrivateApiStatus("imsg");
}

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const probeIMessagePrivateApiMock = vi.hoisted(() => vi.fn<typeof probeIMessagePrivateApi>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const ensureReadyMock = vi.hoisted(() =>
  vi.fn<typeof ensureConfiguredBindingRouteReady>(async () => ({ ok: true })),
);
const dispatchMock = vi.hoisted(() =>
  vi.fn<typeof dispatchReplyWithBufferedBlockDispatcher>(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
);
const debouncerControl = vi.hoisted(() => ({
  holdEntries: false,
  entries: [] as unknown[],
  reset() {
    this.holdEntries = false;
    this.entries = [];
  },
}));
const createChannelInboundDebouncerMock = vi.hoisted(() =>
  vi.fn(
    (opts: {
      onFlush: (
        entries: unknown[],
        createFlush: typeof createTestInboundDebounceFlush,
      ) => { completion: Promise<void> };
    }) => ({
      debouncer: {
        enqueue: async (entry: unknown) => {
          if (!debouncerControl.holdEntries) {
            await opts.onFlush([entry], createTestInboundDebounceFlush).completion;
            return;
          }
          debouncerControl.entries.push(entry);
        },
        flushKey: async () => {},
        cancelKey: () => false,
        drain: async () => {},
      },
    }),
  ),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: ensureReadyMock,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    upsertChannelPairingRequest: vi.fn(),
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: createChannelInboundDebouncerMock,
    shouldDebounceTextInbound: vi.fn(() => false),
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createClientMock,
}));

vi.mock("./probe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./probe.js")>();
  return {
    ...actual,
    probeIMessagePrivateApi: probeIMessagePrivateApiMock,
  };
});

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

describe("iMessage monitor last-route updates", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterAll(async () => {
      await closeOpenClawAgentDatabasesAsync(sessionRoot);
      cleanup();
    });
  });
  const sessionRoot = tempDirs.make("openclaw-imessage-last-route-");
  const openClawStates: OpenClawTestState[] = [];

  beforeEach(() => {
    vi.spyOn(channelInbound, "runChannelInboundEvent").mockImplementation(((params) =>
      runInboundWithDispatch(
        params,
        dispatchMock,
      )) as typeof channelInbound.runChannelInboundEvent);
    installIMessageStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createClientMock.mockReset();
    probeIMessagePrivateApiMock
      .mockReset()
      .mockImplementation(
        async (cliPath) => getCachedIMessagePrivateApiStatus(cliPath) ?? UNAVAILABLE_API,
      );
    readChannelAllowFromStoreMock.mockReset().mockResolvedValue([]);
    ensureReadyMock.mockReset().mockResolvedValue({ ok: true });
    dispatchMock.mockClear();
    createChannelInboundDebouncerMock.mockClear();
    debouncerControl.reset();
    expireCachedPrivateApiStatus();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    resetPluginRuntimeStateForTest();
    vi.useRealTimers();
    await Promise.all(openClawStates.splice(0).map((state) => state.cleanup()));
    vi.unstubAllEnvs();
  });

  function enablePrivateApi(rpcMethods: string[]): void {
    setCachedIMessagePrivateApiStatus("imsg", {
      available: true,
      v2Ready: true,
      selectors: {},
      rpcMethods,
    });
  }

  function inbound(
    id: number,
    guid: string,
    message: Partial<IMessagePayload> = {},
  ): IMessagePayload {
    return {
      id,
      guid,
      chat_id: 123,
      sender: DEFAULT_SENDER,
      is_from_me: false,
      text: "hello",
      is_group: false,
      created_at: new Date().toISOString(),
      ...message,
    };
  }

  it.each([
    ["SMS", false, 101, 123, "SMS;-;+15550001111", "reply over the originating service"],
    ["group", true, 103, 456, "iMessage;+;chat456", "group reply"],
  ] as const)(
    "preserves %s through final delivery and last-route",
    async (name, group, id, chat, guid, reply) => {
      enablePrivateApi(["watch.subscribe", "send", "typing", "read"]);
      const configuredStore = path.join(
        createTestStateDir("openclaw-imsg-route-"),
        "sessions.json",
      );
      dispatchMock.mockImplementationOnce(async (params) => {
        await params.dispatcherOptions.deliver({ text: reply }, { kind: "final" });
        return EMPTY_DISPATCH_RESULT;
      });
      const client = await runMessageCase({
        auxiliaryRequests: {
          read: { ok: true },
          send: { guid: `${name}-reply-guid` },
          typing: { ok: true },
        },
        message: inbound(id, `${name}-route-guid`, {
          chat_id: chat,
          chat_guid: guid,
          is_group: group,
          ...(group ? {} : { chat_identifier: DEFAULT_SENDER }),
        }),
        monitor: group
          ? { allowlist: false, imessage: { groupPolicy: "open" } }
          : { session: { dmScope: "per-channel-peer", store: configuredStore } },
      });
      const auxiliary = client.auxiliaryClient!;
      if (!group) {
        await vi.waitFor(() => {
          expectRpc(auxiliary, "typing", { service: "sms", to: DEFAULT_SENDER, typing: true });
        });
      }
      expectRpc(auxiliary, "send", {
        chat_id: chat,
        text: reply,
        ...(group ? { service: "auto" } : {}),
      });
      expect(dispatchMock.mock.calls[0]?.[0].ctx).toMatchObject(
        group
          ? { ChatType: "group", From: "imessage:group:456", To: "chat_id:456" }
          : { From: `sms:${DEFAULT_SENDER}`, To: "chat_id:123" },
      );
      if (group) {
        return;
      }
      expectRpc(auxiliary, "read", { chat_guid: guid });
      await vi.waitFor(() => {
        expect(
          getSessionEntry({
            storePath: resolveStorePath(configuredStore, { agentId: "main" }),
            sessionKey: `agent:main:imessage:direct:${DEFAULT_SENDER}`,
          }),
        ).toMatchObject({
          delivery: {
            context: { channel: "imessage", to: `sms:${DEFAULT_SENDER}` },
            route: { target: { to: `sms:${DEFAULT_SENDER}` } },
          },
        });
      });
    },
  );

  function makeWatchClient(params: WatchClientParams = {}) {
    let onNotification:
      | NonNullable<NonNullable<Parameters<typeof createIMessageRpcClient>[0]>["onNotification"]>
      | undefined;
    const notify = (message: IMessagePayload) => {
      onNotification?.({ method: "message", params: { message } });
    };
    const messages = params.messages ?? (params.message ? [params.message] : undefined);
    const onClose =
      params.onClose ??
      (messages
        ? async (notifyMessage: (message: IMessagePayload) => void) => {
            for (const message of messages) {
              notifyMessage(message);
            }
            await settleNotifications();
            await params.afterNotify?.();
          }
        : undefined);
    const auxiliaryClient = params.auxiliaryRequests
      ? {
          request: vi.fn(createIMessageTestRequest(params.auxiliaryRequests)),
          stop: vi.fn(async () => {}),
        }
      : undefined;
    const client = {
      request: vi.fn(
        createIMessageTestRequest({ "watch.subscribe": { subscription: 1 }, ...params.requests }),
      ),
      waitForClose: vi.fn(() => onClose?.(notify) ?? Promise.resolve()),
      stop: vi.fn(async () => {}),
      auxiliaryClient,
    };
    createClientMock.mockImplementation(async (clientParams) => {
      if (clientParams?.onNotification) {
        onNotification = clientParams.onNotification;
        return client as never;
      }
      if (auxiliaryClient) {
        return auxiliaryClient as never;
      }
      throw new Error("expected iMessage notification handler");
    });
    return client;
  }

  async function runIMessageMonitor(params: MonitorRunParams = {}): Promise<void> {
    await monitorIMessageProvider({
      scheduler: createTestPluginServiceScheduler(),
      ...(params.accountId ? { accountId: params.accountId } : {}),
      config: {
        channels: {
          imessage: {
            ...(params.allowlist === false
              ? {}
              : { dmPolicy: "allowlist", allowFrom: [DEFAULT_SENDER] }),
            ...params.imessage,
          },
        },
        messages: { inbound: { debounceMs: 0 }, ...params.messages },
        ...(params.agents ? { agents: params.agents } : {}),
        ...(params.bindings ? { bindings: params.bindings } : {}),
        session: { mainKey: "main", ...params.session },
      } as never,
      runtime: params.runtime ?? { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
    });
  }

  function createTestStateDir(prefix: string): string {
    return tempDirs.make(prefix, sessionRoot);
  }

  async function createRecoveryChatDb(prefix: string, cursor?: number): Promise<string> {
    const dbPath = path.join(createTestStateDir(prefix), "chat.db");
    if (cursor !== undefined) {
      await advanceIMessageRecoveryCursor(
        "default",
        resolveIMessageRecoveryCursorDbIdentity({ dbPath }),
        cursor,
      );
    }
    withChatDb(dbPath, (database) => {
      database.exec("CREATE TABLE message (text TEXT);");
      database.prepare("INSERT INTO message(rowid, text) VALUES (?, ?)").run(5000, "boundary");
    });
    return dbPath;
  }

  async function loadRecoveryCursor(dbPath: string): Promise<number | null> {
    return await loadIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ dbPath }),
    );
  }

  async function runMessageCase(
    params: WatchClientParams & { monitor?: MonitorRunParams },
  ): Promise<ReturnType<typeof makeWatchClient>> {
    const { monitor, ...clientParams } = params;
    const client = makeWatchClient(clientParams);
    await runIMessageMonitor(monitor);
    return client;
  }

  function createConfiguredBindingMonitor(
    overrides: Omit<MonitorRunParams, "bindings"> = {},
  ): MonitorRunParams {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "imessage",
          source: "test",
          plugin: { id: "imessage", bindings: imessagePlugin.bindings },
        },
      ]),
    );
    return {
      ...overrides,
      agents: { entries: { main: {}, codex: {} } },
      bindings: [
        { agentId: "main", match: { channel: "imessage", accountId: "default" } },
        {
          type: "acp",
          agentId: "codex",
          match: {
            channel: "imessage",
            accountId: "default",
            peer: { kind: "direct", id: DEFAULT_SENDER },
          },
        },
      ],
    };
  }

  it("delivers eight self-chat turns without counting their paired rows as echo loops", async () => {
    const runtime = createRuntimeSpies();
    const texts = Array.from({ length: 8 }, (_, index) => `self-chat message ${index + 1}`);
    const createdAt = new Date().toISOString();
    await runMessageCase({
      messages: texts.flatMap((text, index) =>
        [true, false].map((isFromMe) =>
          inbound(index * 2 + (isFromMe ? 1 : 2), `self-chat-${index}-${isFromMe}`, {
            text,
            chat_identifier: DEFAULT_SENDER,
            is_from_me: isFromMe,
            created_at: createdAt,
            destination_caller_id: DEFAULT_SENDER,
          }),
        ),
      ),
      monitor: { runtime },
    });
    expect(dispatchMock).toHaveBeenCalledTimes(texts.length);
    expect(dispatchMock.mock.calls.map(([params]) => params.ctx.BodyForAgent)).toEqual(texts);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(
      runtime.log.mock.calls.some(([message]) => String(message).includes("rate limiter tripped")),
    ).toBe(false);
  });

  it("waits for configured ACP target readiness before dispatching an authorized message", async ({
    signal,
  }) => {
    const readiness = createDeferred<{ ok: true }>();
    const readinessEntered = createDeferred<void>();
    const dispatchEntered = createDeferred<void>();
    ensureReadyMock.mockImplementationOnce(() => {
      readinessEntered.resolve();
      return readiness.promise;
    });
    dispatchMock.mockImplementationOnce(async () => {
      dispatchEntered.resolve();
      return EMPTY_DISPATCH_RESULT;
    });
    makeWatchClient({
      onClose: async (notify) => {
        notify(inbound(81, "acp-ready-81"));
        try {
          await withinTest(readinessEntered.promise, signal);
          expect(ensureReadyMock).toHaveBeenCalledTimes(1);
          expect(dispatchMock).not.toHaveBeenCalled();
          readiness.resolve({ ok: true });
          await withinTest(dispatchEntered.promise, signal);
          expect(dispatchMock).toHaveBeenCalledTimes(1);
        } finally {
          readiness.resolve({ ok: true });
        }
      },
    });

    await runIMessageMonitor(createConfiguredBindingMonitor());

    expect(ensureReadyMock).toHaveBeenCalledWith({
      cfg: expect.any(Object),
      bindingResolution: expect.objectContaining({
        record: expect.objectContaining({
          conversation: expect.objectContaining({
            channel: "imessage",
            accountId: "default",
            conversationId: DEFAULT_SENDER,
          }),
        }),
      }),
    });
    expect(ensureReadyMock.mock.invocationCallOrder[0]).toBeLessThan(
      dispatchMock.mock.invocationCallOrder[0]!,
    );
  });

  it("drops unavailable configured ACP messages before typing, reads, media, history, or dispatch", async () => {
    enablePrivateApi(["watch.subscribe", "typing", "read"]);
    const stageAttachments = vi.spyOn(iMessageMediaStaging, "stageIMessageAttachments");
    ensureReadyMock.mockResolvedValueOnce({
      ok: false,
      error: "ACP backend unavailable",
    });
    const runtime = createRuntimeSpies();
    const stateDir = createTestStateDir("openclaw-imsg-acp-readiness-effects-");

    const client = await runMessageCase({
      requests: {
        "messages.history": { messages: [] },
      },
      auxiliaryRequests: { typing: { ok: true }, read: { ok: true } },
      message: inbound(82, "acp-failed-82", {
        attachments: [{ mime_type: "image/png", missing: true }],
      }),
      monitor: createConfiguredBindingMonitor({
        runtime,
        imessage: { includeAttachments: true, dmHistoryLimit: 3 },
        session: { dmScope: "per-channel-peer", store: path.join(stateDir, "sessions.json") },
      }),
    });

    expect(ensureReadyMock).toHaveBeenCalledTimes(1);
    expect({
      nativeEffects: client.auxiliaryClient!.request.mock.calls.map(([method]) => method),
      historyLoads: client.request.mock.calls.filter(([method]) => method === "messages.history")
        .length,
      mediaLoads: stageAttachments.mock.calls.length,
      dispatches: dispatchMock.mock.calls.length,
    }).toEqual({ nativeEffects: [], historyLoads: 0, mediaLoads: 0, dispatches: 0 });
    expect([...runtime.error.mock.calls, ...runtime.log.mock.calls].flat()).toContainEqual(
      expect.stringContaining("ACP backend unavailable"),
    );
  });

  it("does not provision configured ACP targets for unauthorized or reflected messages", async () => {
    await runMessageCase({
      messages: [
        inbound(83, "acp-unauthorized-83", { sender: "+15550009999" }),
        inbound(84, "acp-reflected-84", { text: "<thinking>echoed internal content</thinking>" }),
      ],
      monitor: createConfiguredBindingMonitor(),
    });

    expect(ensureReadyMock).not.toHaveBeenCalled();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  function expectWatchSubscription(
    client: ReturnType<typeof makeWatchClient>,
    sinceRowid?: number,
  ): void {
    const params =
      sinceRowid === undefined
        ? WATCH_SUBSCRIBE_PARAMS
        : { ...WATCH_SUBSCRIBE_PARAMS, since_rowid: sinceRowid };
    expect(client.request).toHaveBeenCalledWith("watch.subscribe", params, WATCH_SUBSCRIBE_OPTIONS);
  }

  it("keeps native typing alive when tool activity arrives before reply text", async () => {
    enablePrivateApi(["watch.subscribe", "send", "typing"]);
    dispatchMock.mockImplementationOnce(async (params) => {
      expect(params.replyOptions).toMatchObject({
        suppressDefaultToolProgressMessages: true,
        allowToolLifecycleWhenProgressHidden: true,
        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
      });
      const onReplyStart =
        params.dispatcherOptions.onReplyStart ??
        params.dispatcherOptions.typingCallbacks?.onReplyStart;
      const onTypingCleanup =
        params.dispatcherOptions.onCleanup ?? params.dispatcherOptions.typingCallbacks?.onCleanup;
      const typingController = createTypingController({
        onReplyStart,
        onCleanup: onTypingCleanup,
        keepalive: false,
      });
      params.replyOptions?.onTypingController?.(typingController);
      try {
        await params.replyOptions?.onToolStart?.({ name: "exec", phase: "start" });
        const onToolResult = params.replyOptions?.onToolResult;
        expect(onToolResult).toBeTypeOf("function");
        await onToolResult?.({
          text: "💨Fast: auto-off(75s>=60s)",
          channelData: { openclawProgressKind: "fast-mode-auto" },
        });
      } finally {
        typingController.markRunComplete();
        typingController.markDispatchIdle();
        typingController.cleanup();
      }
      return EMPTY_DISPATCH_RESULT;
    });

    const client = await runMessageCase({
      requests: {
        typing: { ok: true },
      },
      message: inbound(7, "typing-keepalive-guid-7"),
      monitor: { imessage: { sendReadReceipts: false } },
    });

    await vi.waitFor(() => {
      expectRpc(client, "typing", { typing: true });
      expectRpc(client, "typing", { typing: false });
    });
  });

  it("starts direct typing before dispatching the inbound turn", async () => {
    enablePrivateApi(["watch.subscribe", "send", "typing"]);
    const watchClient = makeWatchClient({
      requests: {
        typing: { ok: true },
      },
      auxiliaryRequests: { typing: { ok: true } },
      message: inbound(12, "typing-early-guid-12"),
      afterNotify: async () => {
        await vi.waitFor(() => {
          expectRpc(earlyTypingClient, "typing", { typing: true, to: DEFAULT_SENDER });
          expect(dispatchMock).toHaveBeenCalledTimes(1);
        });
      },
    });
    const earlyTypingClient = watchClient.auxiliaryClient!;
    dispatchMock.mockImplementationOnce(async () => {
      expectRpc(earlyTypingClient, "typing", { typing: true, to: DEFAULT_SENDER });
      return EMPTY_DISPATCH_RESULT;
    });

    await runIMessageMonitor({ imessage: { sendReadReceipts: false } });

    expect(watchClient.request).not.toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ typing: true }),
      expect.anything(),
    );
    await vi.waitFor(() => {
      expectRpc(earlyTypingClient, "typing", { typing: false, to: DEFAULT_SENDER });
    });
  });

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
      message: inbound(14, "private-api-refresh-guid-14"),
    });
    const auxiliaryClient = client.auxiliaryClient!;

    expect(probeIMessagePrivateApiMock).toHaveBeenCalledWith("imsg", 10_000);
    expectRpc(auxiliaryClient, "read", { chat_id: 123 });
    expectRpc(auxiliaryClient, "typing", { typing: true });
  });

  it.each([
    {
      name: "typingMode is thinking",
      monitor: { agents: { defaults: { typingMode: "thinking" } } },
    },
    {
      name: "sendPolicy denies source delivery",
      monitor: { session: { sendPolicy: { default: "deny" } } },
    },
  ])("does not start direct tool typing when $name", async ({ name, monitor }) => {
    enablePrivateApi(["watch.subscribe", "send", "typing"]);
    dispatchMock.mockImplementationOnce(async (params) => {
      expect([
        params.replyOptions?.suppressDefaultToolProgressMessages,
        params.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed,
        params.replyOptions?.onToolStart,
      ]).toEqual([undefined, undefined, undefined]);
      return EMPTY_DISPATCH_RESULT;
    });

    const client = await runMessageCase({
      message: inbound(8, name),
      monitor: { ...monitor, imessage: { sendReadReceipts: false } },
    });

    await expectDispatches();
    expect(client.request).not.toHaveBeenCalledWith(
      "typing",
      expect.objectContaining({ typing: true }),
      expect.anything(),
    );
  });

  it("does not wait for read receipts before dispatching the inbound turn", async () => {
    enablePrivateApi(["watch.subscribe", "read"]);
    const watchClient = await runMessageCase({
      auxiliaryRequests: { read: () => new Promise(() => {}) },
      message: inbound(11, "read-receipt-guid-11"),
      afterNotify: expectDispatches,
    });
    const readClient = watchClient.auxiliaryClient!;

    expectRpc(readClient, "read", { chat_id: 123 });
    expect(watchClient.request).not.toHaveBeenCalledWith(
      "read",
      expect.anything(),
      expect.anything(),
    );
    expect(dispatchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "account block-streaming override", channel: false, account: { enabled: true } },
    {
      name: "channel streaming with account coalescing",
      channel: true,
      account: { coalesce: { idleMs: 1 } },
    },
  ])("preserves $name", async ({ name, channel, account }) => {
    await runMessageCase({
      message: inbound(11, name),
      monitor: {
        accountId: "personal",
        imessage: {
          sendReadReceipts: false,
          streaming: { block: { enabled: channel } },
          accounts: { personal: { streaming: { block: account } } },
        },
      },
    });
    await expectDispatches();
    expect(dispatchMock.mock.calls[0]?.[0].replyOptions?.disableBlockStreaming).toBe(false);
  });

  it("recovers over a remote cliPath: replays from the cursor even without a local chat.db boundary", async () => {
    await advanceIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ remoteHost: "user@gateway-host" }),
      4990,
    );
    const client = await runMessageCase({
      monitor: { imessage: { remoteHost: "user@gateway-host" } },
    });

    expectWatchSubscription(client, 4990);
  });

  it("routes legacy catchup through durable ingress and rejects a live GUID overlap", async () => {
    const dbPath = await createRecoveryChatDb("openclaw-imsg-catchup-window-");
    const createdAt = new Date().toISOString();
    const historyMessage = inbound(4995, "CATCHUP-LIVE-OVERLAP-GUID", { created_at: createdAt });
    const client = await runMessageCase({
      requests: {
        "chats.list": { chats: [{ id: 123, last_message_at: createdAt }] },
        "messages.history": { messages: [historyMessage] },
      },
      message: { ...historyMessage, id: 5001 },
      monitor: {
        imessage: { dbPath, catchup: { enabled: true, perRunLimit: 25, maxAgeMinutes: 60 } },
      },
    });

    expectWatchSubscription(client);
    expect(client.request).toHaveBeenCalledWith(
      "chats.list",
      { limit: 200 },
      { timeoutMs: 30_000 },
    );
    await expectDispatches();
  });

  it("does not treat startup-boundary rows as recovery replay without a prior cursor", async () => {
    const dbPath = await createRecoveryChatDb("openclaw-imsg-first-run-boundary-");
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const client = await runMessageCase({
      message: inbound(4995, "FIRST-RUN-HISTORY-GUID-4995", { created_at: thirtyMinAgo }),
      monitor: { imessage: { dbPath } },
    });

    expectWatchSubscription(client, 5000);
    await settleNotifications();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("records a suppressed live row so a later replay of the same row is deduped, not delivered", async () => {
    const dbPath = await createRecoveryChatDb("openclaw-imsg-suppress-record-");
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    await runMessageCase({
      messages: [
        inbound(5001, "SUPPRESSED-GUID", { created_at: thirtyMinAgo }),
        inbound(5001, "SUPPRESSED-GUID"),
      ],
      monitor: { imessage: { dbPath } },
    });

    await settleNotifications();
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("advances the recovery cursor after durable enqueue before dispatch", async () => {
    debouncerControl.holdEntries = true;
    const dbPath = await createRecoveryChatDb("openclaw-imsg-recovery-failed-", 4990);
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();

    const client = await runMessageCase({
      messages: [4995, 4996].map((id) =>
        inbound(id, `FAILED-REPLAY-GUID-${id}`, { created_at: thirtyMinAgo }),
      ),
      monitor: { imessage: { dbPath } },
    });

    expectWatchSubscription(client, 4990);
    await vi.waitFor(() => {
      expect(debouncerControl.entries).toHaveLength(2);
    });
    expect(await loadRecoveryCursor(dbPath)).toBe(4996);
  });

  it("does not self-fence past the first row inserted while an empty rebuilt chat.db starts", async () => {
    const stateDir = createTestStateDir("openclaw-imsg-db-rebuilt-startup-race-");
    const dbPath = path.join(stateDir, "chat.db");
    await advanceIMessageRecoveryCursor(
      "default",
      resolveIMessageRecoveryCursorDbIdentity({ dbPath }),
      9000,
    );
    createChatDb(dbPath);

    let effectiveWatcherCursor: number | undefined;
    const client = makeWatchClient({
      requests: {
        "watch.subscribe": async (params) => {
          insertChatDbMessage(
            dbPath,
            createChatDbMessage(1, "REBUILT-STARTUP-GUID-1", "sent while the watcher starts"),
          );
          const requestedCursor = params?.since_rowid;
          const maxRowid = withChatDb(
            dbPath,
            (database) =>
              (
                database.prepare("SELECT MAX(ROWID) AS maxRowid FROM message").get() as {
                  maxRowid: number;
                }
              ).maxRowid,
          );
          // Match imsg's MessageWatcher.start contract: cursor 0 self-fences to
          // the subscribe-time maximum, while any other explicit cursor is kept.
          effectiveWatcherCursor =
            requestedCursor === 0
              ? maxRowid
              : typeof requestedCursor === "number"
                ? requestedCursor
                : maxRowid;
          return { subscription: 1 };
        },
      },
      onClose: async (notify) => {
        for (const message of readChatDbMessagesAfter(dbPath, effectiveWatcherCursor ?? 0)) {
          notify(message);
        }
        await settleNotifications();
      },
    });

    await runIMessageMonitor({ imessage: { dbPath } });

    expectWatchSubscription(client, -1);
    await expectDispatches();
    expect(await loadRecoveryCursor(dbPath)).toBe(1);
  });

  it("repairs anchorless group watch payloads before routing or cursor updates", async () => {
    openClawStates.push(
      await createOpenClawTestState({
        layout: "state-only",
        prefix: "openclaw-imsg-anchor-repair-",
      }),
    );

    makeWatchClient({
      requests: {
        "chats.list": { chats: [{ id: 349 }] },
        "messages.history": (params) => {
          expect(params?.chat_id).toBe(349);
          return {
            messages: [
              {
                id: 9500,
                guid: "ANCHORLESS-GROUP-GUID",
                chat_id: 349,
                chat_guid: "iMessage;+;chat349",
                chat_identifier: "chat349",
                chat_name: "Project group",
                participants: ["+15550001111", "+15550002222"],
                sender: "+15550001111",
                destination_caller_id: "+15550001111",
                is_from_me: false,
                is_group: true,
              },
            ],
          };
        },
      },
      message: inbound(9500, "ANCHORLESS-GROUP-GUID", {
        chat_id: 0,
        sender: "+15550001111",
        text: "@openclaw check this https://example.com",
        chat_guid: "",
        chat_identifier: "",
        chat_name: "",
        participants: null,
      }),
    });

    await runIMessageMonitor({
      imessage: { groupPolicy: "open", groups: { "*": { requireMention: true } } },
      messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
      allowlist: false,
    });

    await expectDispatches();
    const dispatchParams = dispatchMock.mock.calls.at(0)?.[0];
    expect(dispatchParams?.ctx).toMatchObject({
      To: "chat_id:349",
      From: "imessage:group:349",
      ChatType: "group",
      SessionKey: "agent:main:imessage:group:349",
    });
    expect(dispatchParams?.ctx.To).not.toBe("imessage:+15550001111");
  });

  it("suppresses anchorless watch payloads when authoritative history is from-me (#104136)", async () => {
    const runtime = createRuntimeSpies();
    const common = {
      id: 9501,
      guid: ANCHOR_REPAIR_GUID,
      is_group: false,
      service: "iMessage",
      destination_caller_id: "+15550000001",
    };
    const history = {
      ...common,
      chat_id: 42,
      chat_guid: "iMessage;-;+15550000002",
      chat_identifier: "+15550000002",
      sender: "+15550000002",
      is_from_me: true,
    };

    await runMessageCase({
      requests: {
        "chats.list": { chats: [{ id: 42 }] },
        "messages.history": (params) => {
          expect(params?.chat_id).toBe(42);
          return { messages: [history] };
        },
      },
      message: inbound(common.id, common.guid, {
        ...common,
        chat_id: 0,
        chat_guid: "",
        chat_identifier: "",
        sender: "+15550000001",
        text: "outgoing row with broken direction",
      }),
      monitor: {
        imessage: { allowFrom: ["+15550000002"] },
        runtime,
      },
    });

    await vi.waitFor(() => {
      expect(runtime.error).toHaveBeenCalled();
    });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(runtime.error.mock.calls.at(-1)?.[0]).toContain(
      "recovered authoritative row is from-me",
    );
  });
  it("does not stage local attachments for messages dropped by inbound policy", async () => {
    const stage = vi
      .spyOn(iMessageMediaStaging, "stageIMessageAttachments")
      .mockResolvedValue({ attachments: [], unavailableCount: 0 });
    await runMessageCase({
      message: inbound(1, "dropped-media-policy-guid-1", {
        text: "no mention here",
        is_group: true,
        attachments: [
          {
            original_path: "/Users/openclaw/Library/Messages/Attachments/AA/BB/photo.heic",
            mime_type: "image/heic",
            missing: false,
          },
        ],
      }),
      monitor: {
        allowlist: false,
        imessage: {
          includeAttachments: true,
          attachmentRoots: ["/Users/*/Library/Messages/Attachments"],
          dmPolicy: "open",
          groupPolicy: "open",
          groups: { "*": { requireMention: true } },
        },
        messages: { groupChat: { mentionPatterns: ["@openclaw"] } },
      },
    });
    expect(readChannelAllowFromStoreMock).toHaveBeenCalled();
    expect(stage).not.toHaveBeenCalled();
  });

  it.each([
    { name: "admits an attachment-only message when the image is unavailable", pdf: false },
    {
      name: "uses the first materialized attachment type when earlier media is unavailable",
      pdf: true,
    },
  ])("$name", async ({ name, pdf }) => {
    const stage = vi.spyOn(iMessageMediaStaging, "stageIMessageAttachments").mockResolvedValue({
      attachments: [STAGED_MISSING_IMAGE, ...(pdf ? [STAGED_PDF] : [])],
      unavailableCount: 1,
    });
    const runtime = createRuntimeSpies();
    await runMessageCase({
      message: inbound(1, name, {
        text: "",
        chat_identifier: DEFAULT_SENDER,
        attachments: [MISSING_IMAGE, ...(pdf ? [PDF] : [])],
      }),
      monitor: {
        runtime,
        imessage: {
          includeAttachments: true,
          attachmentRoots: [ATTACHMENT_ROOT],
          groupPolicy: "open",
        },
      },
    });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(stage).toHaveBeenCalledTimes(1);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    const ctx = dispatchMock.mock.calls[0]?.[0].ctx;
    expect(ctx?.BodyForAgent).toBe("[imessage attachment unavailable]");
    const media = ctx?.media;
    expect(media?.map((fact) => fact.contentType ?? fact.kind)).toEqual(
      pdf ? ["image/heic", "application/pdf"] : ["image/heic"],
    );
    expect(media?.map((fact) => fact.url)).toEqual(pdf ? [undefined, PDF_PATH] : [undefined]);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

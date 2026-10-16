import path from "node:path";
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import {
  addTestHook,
  createTestInboundDebounceFlush,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { createPluginRegistryOwner } from "openclaw/plugin-sdk/plugin-test-runtime";
import { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imessagePlugin } from "./channel.js";
import type { createIMessageRpcClient } from "./client.js";
import { createIMessageConversationBindingManagerV2 } from "./conversation-bindings.js";
import { monitorIMessageProvider } from "./monitor.js";
import { runInboundWithDispatch } from "./monitor.last-route.test-support.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./monitor/types.js";
import { setCachedIMessagePrivateApiStatus } from "./private-api-status.js";
import { getIMessageRuntime } from "./runtime.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitReady = vi.hoisted(() => vi.fn<typeof waitForTransportReady>(async () => {}));
const createClient = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const shouldDebounce = vi.hoisted(() => vi.fn(() => false));
const delivery = vi.hoisted(() => ({
  flush: false,
  onFlushed: undefined as (() => void) | undefined,
}));

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitReady,
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn(
      (opts: {
        shouldDebounce: (entry: unknown) => boolean;
        onFlush: (
          entries: unknown[],
          createFlush: typeof createTestInboundDebounceFlush,
        ) => { completion: Promise<void> };
      }) => ({
        debouncer: {
          enqueue: async (entry: unknown) => {
            opts.shouldDebounce(entry);
            if (delivery.flush) {
              try {
                await opts.onFlush([entry], createTestInboundDebounceFlush).completion;
              } finally {
                delivery.onFlushed?.();
              }
            }
          },
        },
      }),
    ),
    shouldDebounceTextInbound: shouldDebounce,
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createClient,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

function runMonitor(
  config: MonitorIMessageOpts["config"],
  runtime?: MonitorIMessageOpts["runtime"],
) {
  return monitorIMessageProvider({
    scheduler: createTestPluginServiceScheduler(),
    config: { ...config, session: { mainKey: "main" } },
    runtime,
  });
}

describe("iMessage plugin payload attachments", () => {
  let message: IMessagePayload;
  let afterNotify: () => Promise<void>;
  let nativeClient:
    | { request: (method: string) => Promise<unknown>; stop: () => Promise<void> }
    | undefined;
  beforeEach(() => {
    installIMessageStateRuntimeForTest();
    waitReady.mockReset().mockResolvedValue(undefined);
    message = {
      id: 1,
      guid: "plugin-payload-guid-1",
      chat_id: 123,
      sender: "+15550001111",
      is_from_me: false,
      is_group: false,
    };
    afterNotify = async () => {};
    nativeClient = undefined;
    createClient.mockReset().mockImplementation(async (params) => {
      if (!params?.onNotification) {
        if (!nativeClient) {
          throw new Error("expected iMessage notification handler");
        }
        return nativeClient as never;
      }
      return {
        request: vi.fn(async () => ({ subscription: 1 })),
        waitForClose: vi.fn(async () => {
          params.onNotification?.({ method: "message", params: { message } });
          await afterNotify();
        }),
        stop: vi.fn(async () => {}),
      } as never;
    });
    shouldDebounce.mockReset().mockReturnValue(false);
    delivery.flush = false;
    delivery.onFlushed = undefined;
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });

  it("does not count Apple rich-link plugin payloads as user media", async () => {
    message = {
      ...message,
      text: "https://example.com/article",
      attachments: [
        {
          original_path: "/link.pluginPayloadAttachment",
        },
      ],
    };

    await runMonitor({ channels: { imessage: { includeAttachments: true, dmPolicy: "open" } } });

    expect(shouldDebounce).toHaveBeenCalledWith(
      expect.objectContaining({ text: "https://example.com/article", hasMedia: false }),
    );
  });

  it.each([
    { kind: "final", text: "provider-visible ordinary final", visible: true },
    { kind: "tool", text: "<thinking>private reasoning</thinking>", visible: false },
  ] as const)(
    "settles direct $kind delivery through actual provider, hooks, and SQLite ($visible)",
    async ({ kind, text, visible }) => {
      delivery.flush = true;
      const flushed = Promise.withResolvers<void>();
      delivery.onFlushed = flushed.resolve;
      const errors = vi.fn();
      const messageSent = vi.fn();
      const registry = createTestRegistry([
        { pluginId: "imessage", source: "test", plugin: imessagePlugin },
      ]);
      setActivePluginRegistry(registry);
      const owner = createPluginRegistryOwner(registry);
      const bindings = createIMessageConversationBindingManagerV2({ cfg: {} });
      addTestHook({
        registry,
        pluginId: "imessage-monitor-proof",
        hookName: "message_sent",
        handler: messageSent,
      });
      initializeGlobalHookRunner(registry);
      setCachedIMessagePrivateApiStatus("imsg", {
        available: true,
        v2Ready: true,
        selectors: {},
        rpcMethods: ["watch.subscribe", "send"],
      });

      const dispatch = vi.fn<typeof dispatchReplyWithBufferedBlockDispatcher>(async (params) => {
        if (kind === "final") {
          // Inject only model output; delivery and persistence remain production-owned.
          return await dispatchReplyWithBufferedBlockDispatcher({
            ...params,
            replyResolver: async () => {
              const prepared = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
              expect(prepared).toBeDefined();
              expect(prepared).not.toBe(registry);
              return { text };
            },
          });
        }
        const settled = await params.dispatcherOptions.deliver({ text }, { kind });
        expect(settled).toMatchObject({
          visibleReplySent: false,
          suppression: { reason: "no_visible_result" },
        });
        return { queuedFinal: false, counts: { tool: 1, block: 0, final: 0 } };
      });
      vi.spyOn(channelInbound, "runChannelInboundEvent").mockImplementation(async (params) =>
        runInboundWithDispatch(params, dispatch, (durable) => {
          if (kind === "final") {
            expect(durable).toMatchObject({ to: expect.any(String) });
            expect(durable).not.toHaveProperty("prepareRuntimeHandoff");
          }
        }),
      );

      nativeClient = {
        request: vi.fn(async (method: string) => {
          if (method !== "send") {
            throw new Error(`unexpected native iMessage method ${method}`);
          }
          return { guid: `native-${kind}-guid`, status: "sent" };
        }),
        stop: vi.fn(async () => {}),
      };
      message = {
        ...message,
        guid: `monitor-${kind}-${visible}-guid`,
        text: "exercise actual direct delivery",
        created_at: new Date().toISOString(),
      };
      afterNotify = () => flushed.promise;

      try {
        await withPluginRuntimeRegistryScope(registry, () =>
          runMonitor(
            {
              plugins: { slots: { memory: "none" } },
              channels: {
                imessage: {
                  dmPolicy: "allowlist",
                  allowFrom: ["+15550001111"],
                  sendReadReceipts: false,
                },
              },
              messages: { inbound: { debounceMs: 0 } },
            },
            { error: errors, exit: vi.fn(), log: vi.fn() },
          ),
        );
      } finally {
        bindings.stop();
        await owner.close();
      }

      expect(errors.mock.calls).toEqual([]);
      if (!visible) {
        expect(nativeClient.request).not.toHaveBeenCalled();
        expect(messageSent).not.toHaveBeenCalled();
        return;
      }
      expect(dispatch).toHaveBeenCalledOnce();
      expect(nativeClient.request).toHaveBeenCalledExactlyOnceWith(
        "send",
        expect.objectContaining({ text }),
        expect.any(Object),
      );
      expect(messageSent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ content: text, success: true, messageId: `native-${kind}-guid` }),
        expect.objectContaining({ channelId: "imessage" }),
      );

      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(
        path.join(getIMessageRuntime().state.resolveStateDir(), "state", "openclaw.sqlite"),
        { readOnly: true },
      );
      try {
        const persisted = database
          .prepare(
            "SELECT value_json FROM plugin_state_entries WHERE plugin_id = ? AND namespace = ?",
          )
          .all("imessage", "imessage.sent-echoes");
        expect(persisted).toContainEqual(
          expect.objectContaining({ value_json: expect.stringContaining(`native-${kind}-guid`) }),
        );
      } finally {
        database.close();
      }
    },
  );
});

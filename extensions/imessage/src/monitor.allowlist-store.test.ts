// Imessage tests cover monitor pairing-store admission failures.
import * as channelInbound from "openclaw/plugin-sdk/channel-inbound";
import { createTestInboundDebounceFlush } from "openclaw/plugin-sdk/channel-test-helpers";
import type { dispatchReplyWithBufferedBlockDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import type { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { createIMessageRpcClient } from "./client.js";
import { monitorIMessageProvider } from "./monitor.js";
import { installIMessageStateRuntimeForTest } from "./test-support/runtime.js";

const waitForTransportReadyMock = vi.hoisted(() =>
  vi.fn<typeof waitForTransportReady>(async () => {}),
);
const createIMessageRpcClientMock = vi.hoisted(() => vi.fn<typeof createIMessageRpcClient>());
const readChannelAllowFromStoreMock = vi.hoisted(() => vi.fn(async () => [] as string[]));
const upsertChannelPairingRequestMock = vi.hoisted(() => vi.fn());
const dispatchReplyWithBufferedBlockDispatcherMock = vi.hoisted(() =>
  vi.fn<typeof dispatchReplyWithBufferedBlockDispatcher>(async () => ({
    queuedFinal: false,
    counts: { tool: 0, block: 0, final: 0 },
  })),
);

vi.mock("openclaw/plugin-sdk/transport-ready-runtime", () => ({
  waitForTransportReady: waitForTransportReadyMock,
}));

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>();
  return {
    ...actual,
    readChannelAllowFromStore: readChannelAllowFromStoreMock,
    upsertChannelPairingRequest: upsertChannelPairingRequestMock,
  };
});

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    createChannelInboundDebouncer: vi.fn((opts) => ({
      debouncer: {
        enqueue: async (entry: unknown) =>
          await opts.onFlush([entry], createTestInboundDebounceFlush).completion,
        flushKey: async () => {},
        cancelKey: () => false,
        drain: async () => {},
      },
    })),
    shouldDebounceTextInbound: vi.fn(() => false),
  };
});

vi.mock("./client.js", () => ({
  createIMessageRpcClient: createIMessageRpcClientMock,
}));

vi.mock("./monitor/abort-handler.js", () => ({
  attachIMessageMonitorAbortHandler: vi.fn(() => () => {}),
}));

type RunChannelInboundEventParams = Parameters<typeof channelInbound.runChannelInboundEvent>[0];

async function runChannelInboundEventForAllowlistStoreTest(params: RunChannelInboundEventParams) {
  const input = await params.adapter.ingest(params.raw);
  if (!input) {
    return { admission: { kind: "drop" as const, reason: "ingest-null" }, dispatched: false };
  }
  const eventClass = (await params.adapter.classify?.(input)) ?? {
    kind: "message" as const,
    canStartAgentTurn: true,
  };
  if (!eventClass.canStartAgentTurn) {
    return {
      admission: { kind: "handled" as const, reason: `event:${eventClass.kind}` },
      dispatched: false,
    };
  }
  const rawPreflight = await params.adapter.preflight?.(input, eventClass);
  const preflight =
    rawPreflight && "kind" in rawPreflight ? { admission: rawPreflight } : rawPreflight;
  const preflightFacts = preflight ?? {};
  const preflightAdmission = preflightFacts.admission;
  if (
    preflightAdmission &&
    preflightAdmission.kind !== "dispatch" &&
    preflightAdmission.kind !== "observeOnly"
  ) {
    return { admission: preflightAdmission, dispatched: false };
  }
  const turn = await params.adapter.resolveTurn(input, eventClass, preflightFacts);
  if (!("route" in turn) || !("delivery" in turn)) {
    throw new Error("expected assembled iMessage channel turn plan");
  }
  const admission = turn.admission ?? preflightAdmission ?? { kind: "dispatch" as const };
  const result = {
    admission,
    dispatched: true as const,
    ctxPayload: turn.ctxPayload,
    routeSessionKey: turn.route.sessionKey,
    dispatchResult: await dispatchReplyWithBufferedBlockDispatcherMock({
      ctx: turn.ctxPayload,
      cfg: turn.cfg,
      dispatcherOptions: {
        ...turn.dispatcherOptions,
        deliver: turn.delivery.deliver,
        onError: turn.delivery.onError,
      },
      toolsAllow: turn.toolsAllow,
      replyOptions: turn.replyOptions,
      replyResolver: turn.replyResolver,
    }),
  };
  await params.adapter.onFinalize?.(result);
  return result;
}

type InboundStoreCase = {
  guid: string;
  isGroup?: boolean;
  chatId?: number;
  imessage: Record<string, unknown>;
  accessGroups?: Record<string, unknown>;
};

type InboundStoreRuntime = {
  error: ReturnType<typeof vi.fn>;
  exit: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
};

async function runInboundStoreCase(params: {
  message: InboundStoreCase;
  runtime?: InboundStoreRuntime;
}) {
  const runtime = params.runtime ?? { error: vi.fn(), exit: vi.fn(), log: vi.fn() };
  const sendClient = {
    request: vi.fn(async () => ({ guid: "pairing-reply-guid" })),
    stop: vi.fn(async () => {}),
  };
  let onNotification:
    | ((message: { method: string; params: unknown }) => void | Promise<void>)
    | undefined;
  const watchClient = {
    request: vi.fn(async () => ({ subscription: 1 })),
    waitForClose: vi.fn(async () => {
      await onNotification?.({
        method: "message",
        params: {
          message: {
            id: 1,
            guid: params.message.guid,
            chat_id: params.message.chatId ?? 123,
            chat_identifier: "+15550001111",
            sender: "+15550001111",
            is_from_me: false,
            is_group: params.message.isGroup ?? false,
            text: "hello from a paired sender",
            created_at: new Date().toISOString(),
          },
        },
      });
      await Promise.resolve();
      await Promise.resolve();
    }),
    stop: vi.fn(async () => {}),
  };
  createIMessageRpcClientMock.mockImplementation(async (clientParams) => {
    if (clientParams?.onNotification) {
      onNotification = clientParams.onNotification;
      return watchClient as never;
    }
    return sendClient as never;
  });

  await monitorIMessageProvider({
    config: {
      channels: {
        imessage: params.message.imessage,
      },
      ...(params.message.accessGroups ? { accessGroups: params.message.accessGroups } : {}),
      messages: { inbound: { debounceMs: 0 } },
      session: { mainKey: "main" },
    } as never,
    runtime: runtime as never,
  });

  return { runtime, sendClient };
}

describe("iMessage inbound pairing-store read failures", () => {
  beforeEach(() => {
    vi.spyOn(channelInbound, "runChannelInboundEvent").mockImplementation(
      runChannelInboundEventForAllowlistStoreTest as typeof channelInbound.runChannelInboundEvent,
    );
    installIMessageStateRuntimeForTest();
    waitForTransportReadyMock.mockReset().mockResolvedValue(undefined);
    createIMessageRpcClientMock.mockReset();
    readChannelAllowFromStoreMock.mockReset().mockRejectedValue(new Error("pairing db locked"));
    upsertChannelPairingRequestMock.mockReset();
    dispatchReplyWithBufferedBlockDispatcherMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails inbound when the pairing store cannot be read instead of treating the sender as unpaired", async () => {
    const { runtime, sendClient } = await runInboundStoreCase({
      message: {
        guid: "pairing-store-read-fail-guid-1",
        imessage: { dmPolicy: "pairing" },
      },
    });

    await vi.waitFor(() => expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1));
    expect(readChannelAllowFromStoreMock).toHaveBeenCalledWith(
      "imessage",
      expect.anything(),
      expect.any(String),
    );
    expect(upsertChannelPairingRequestMock).not.toHaveBeenCalled();
    expect(sendClient.request).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
    expect(runtime.error.mock.calls.flat().map(String).join("\n")).toMatch(
      /inbound dispatch failed|pairing db locked/i,
    );
  });

  it("fails unpaired pairing DMs when configured allowFrom does not match the sender", async () => {
    const { runtime, sendClient } = await runInboundStoreCase({
      message: {
        guid: "pairing-store-read-fail-unmatched-guid-1",
        imessage: { dmPolicy: "pairing", allowFrom: ["+15559999999"] },
      },
    });

    await vi.waitFor(() => expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1));
    expect(upsertChannelPairingRequestMock).not.toHaveBeenCalled();
    expect(sendClient.request).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
    expect(runtime.error.mock.calls.flat().map(String).join("\n")).toMatch(
      /inbound dispatch failed|pairing db locked/i,
    );
  });

  it("fails unpaired pairing DMs when the sender is not a configured access-group member", async () => {
    const { runtime, sendClient } = await runInboundStoreCase({
      message: {
        guid: "pairing-store-read-fail-accessgroup-unmatched-guid-1",
        imessage: { dmPolicy: "pairing", allowFrom: ["accessGroup:operators"] },
        accessGroups: {
          operators: {
            type: "message.senders",
            members: { imessage: ["+15559999999"] },
          },
        },
      },
    });

    await vi.waitFor(() => expect(readChannelAllowFromStoreMock).toHaveBeenCalledTimes(1));
    expect(upsertChannelPairingRequestMock).not.toHaveBeenCalled();
    expect(sendClient.request).not.toHaveBeenCalled();
    expect(dispatchReplyWithBufferedBlockDispatcherMock).not.toHaveBeenCalled();
    expect(runtime.error.mock.calls.flat().map(String).join("\n")).toMatch(
      /inbound dispatch failed|pairing db locked/i,
    );
  });

  it.each([
    {
      name: "open DM",
      guid: "pairing-store-open-dm-guid-1",
      imessage: { dmPolicy: "open", allowFrom: ["*"] },
    },
    {
      name: "configured allowlist DM",
      guid: "pairing-store-allowlist-dm-guid-1",
      imessage: { dmPolicy: "allowlist", allowFrom: ["+15550001111"] },
    },
    {
      name: "configured pairing-policy DM",
      guid: "pairing-store-pairing-allowfrom-dm-guid-1",
      imessage: { dmPolicy: "pairing", allowFrom: ["+15550001111"] },
    },
    {
      name: "configured default-policy DM",
      guid: "pairing-store-default-allowfrom-dm-guid-1",
      imessage: { allowFrom: ["+15550001111"] },
    },
    {
      name: "configured access-group pairing-policy DM",
      guid: "pairing-store-pairing-accessgroup-dm-guid-1",
      imessage: { dmPolicy: "pairing", allowFrom: ["accessGroup:operators"] },
      accessGroups: {
        operators: {
          type: "message.senders",
          members: { imessage: ["+15550001111"] },
        },
      },
    },
    {
      name: "configured access-group default-policy DM",
      guid: "pairing-store-default-accessgroup-dm-guid-1",
      imessage: { allowFrom: ["accessGroup:operators"] },
      accessGroups: {
        operators: {
          type: "message.senders",
          members: { imessage: ["+15550001111"] },
        },
      },
    },
    {
      name: "admitted group",
      guid: "pairing-store-group-guid-1",
      isGroup: true,
      imessage: { dmPolicy: "pairing", groupPolicy: "open" },
    },
  ])("admits $name while the pairing store is unreadable", async (testCase) => {
    const { runtime, sendClient } = await runInboundStoreCase({
      message: {
        guid: testCase.guid,
        isGroup: testCase.isGroup,
        imessage: testCase.imessage,
        accessGroups: testCase.accessGroups,
      },
    });

    await vi.waitFor(() =>
      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1),
    );
    expect(readChannelAllowFromStoreMock).not.toHaveBeenCalled();
    expect(upsertChannelPairingRequestMock).not.toHaveBeenCalled();
    expect(sendClient.request).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });
});

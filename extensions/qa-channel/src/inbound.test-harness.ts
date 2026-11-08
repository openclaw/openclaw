import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { onTestFinished, vi } from "vitest";
import { setQaChannelRuntime } from "../api.js";
import { handleQaInbound } from "./inbound.js";

type HandleQaInboundParams = Parameters<typeof handleQaInbound>[0];

export function createQaInboundParams(
  overrides: {
    accountConfig?: HandleQaInboundParams["account"]["config"];
    message?: Partial<HandleQaInboundParams["message"]>;
  } = {},
): HandleQaInboundParams {
  return {
    channelId: "qa-channel",
    channelLabel: "QA Channel",
    account: {
      accountId: "default",
      enabled: true,
      configured: true,
      baseUrl: "http://127.0.0.1:43123",
      botUserId: "openclaw",
      botDisplayName: "OpenClaw QA",
      pollTimeoutMs: 250,
      config: {
        allowFrom: ["*"],
        ...overrides.accountConfig,
      },
    },
    config: {},
    message: {
      id: "msg-1",
      accountId: "default",
      direction: "inbound",
      conversation: { kind: "direct", id: "alice" },
      senderId: "alice",
      senderName: "Alice",
      text: "ping",
      timestamp: 1_777_000_000_000,
      reactions: [],
      ...overrides.message,
    },
  };
}

export function firstRunAssembledParams(runtime: ReturnType<typeof createPluginRuntimeMock>) {
  const call = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0];
  if (!call) {
    throw new Error("expected assembled turn call");
  }
  return call[0];
}

export async function runQaInbound(
  run: (turn: ReturnType<typeof firstRunAssembledParams>) => Promise<void>,
  params = createQaInboundParams(),
) {
  const runtime = createPluginRuntimeMock();
  setQaChannelRuntime(runtime);
  vi.mocked(runtime.channel.inbound.dispatch).mockImplementationOnce(async (turn) => {
    await run(turn);
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.route.sessionKey,
      dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
    };
  });
  await handleQaInbound(params);
}

export async function startQaInbound(
  runtime: ReturnType<typeof createPluginRuntimeMock>,
  params = createQaInboundParams(),
) {
  const entered = createDeferred<void>();
  const release = createDeferred<void>();
  vi.mocked(runtime.channel.inbound.dispatch).mockImplementationOnce(async (turn) => {
    entered.resolve();
    await release.promise;
    return {
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.route.sessionKey,
      dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
    };
  });
  const running = handleQaInbound(params);
  onTestFinished(async () => {
    release.resolve();
    await running;
  });
  await Promise.race([entered.promise, running]);
}

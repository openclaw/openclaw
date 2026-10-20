import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineConfig } from "./types.js";

type LineHandleWebhook = ReturnType<typeof import("./bot.js").createLineBot>["handleWebhook"];
type LineBotOptions = Parameters<typeof import("./bot.js").createLineBot>[0];

const { createLineBotMock, registerWebhookTargetWithPluginRouteMock } = vi.hoisted(() => ({
  createLineBotMock: vi.fn((_options: LineBotOptions) => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn<LineHandleWebhook>().mockResolvedValue("durable"),
    stop: vi.fn(async () => {}),
  })),
  registerWebhookTargetWithPluginRouteMock: vi.fn(),
}));

vi.mock("./bot.js", () => ({ createLineBot: createLineBotMock }));

vi.mock("openclaw/plugin-sdk/runtime-env", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/runtime-env")>(
    "openclaw/plugin-sdk/runtime-env",
  );
  return { ...actual, danger: (value: unknown) => String(value), logVerbose: vi.fn() };
});

vi.mock("openclaw/plugin-sdk/webhook-ingress", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-ingress")>(
    "openclaw/plugin-sdk/webhook-ingress",
  );
  return {
    ...actual,
    normalizePluginHttpPath: (path: string | undefined, fallback: string) => path ?? fallback,
    registerWebhookTargetWithPluginRoute: registerWebhookTargetWithPluginRouteMock,
  };
});

vi.mock("openclaw/plugin-sdk/webhook-request-guards", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-request-guards")>(
    "openclaw/plugin-sdk/webhook-request-guards",
  );
  return { ...actual, runDetachedWebhookWork: vi.fn() };
});

vi.mock("./auto-reply-delivery.js", () => ({ deliverLineAutoReply: vi.fn() }));

const { monitorLineProvider } = await import("./monitor.js");
const { setLineRuntime } = await import("./runtime.js");

type ResolvedTurn = { replyOptions?: { disableBlockStreaming?: boolean } };

afterAll(() => {
  vi.doUnmock("./bot.js");
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.doUnmock("openclaw/plugin-sdk/webhook-request-guards");
  vi.doUnmock("./auto-reply-delivery.js");
  vi.resetModules();
});

beforeEach(() => {
  createLineBotMock.mockClear();
  registerWebhookTargetWithPluginRouteMock
    .mockReset()
    .mockImplementation((params: { target: { path: string } }) => ({
      target: params.target,
      unregister: () => {},
    }));
});

async function disableBlockStreamingFor(line: LineConfig, startupLine: LineConfig = {}) {
  let resolvedTurn: ResolvedTurn | undefined;
  setLineRuntime({
    channel: {
      inbound: {
        run: async (runParams: { adapter: { resolveTurn: () => ResolvedTurn } }) => {
          resolvedTurn = runParams.adapter.resolveTurn();
          return { dispatched: false };
        },
      },
    },
  } as unknown as Parameters<typeof setLineRuntime>[0]);

  const monitor = await monitorLineProvider({
    channelAccessToken: "token",
    channelSecret: "secret", // pragma: allowlist secret
    config: { channels: { line: startupLine } } as OpenClawConfig,
    runtime: {} as RuntimeEnv,
  });
  const onMessage = createLineBotMock.mock.calls[0]?.[0]?.onMessage;
  if (!onMessage) {
    throw new Error("expected the LINE bot to receive an inbound message handler");
  }

  try {
    await onMessage(
      {
        ctxPayload: { From: "line:group:C1", MessageSid: "m1", RawBody: "hi" },
        route: { accountId: "default", agentId: "main", sessionKey: "line:C1" },
        isGroup: true,
        accountId: "default",
        turn: { record: {} },
      } as unknown as Parameters<typeof onMessage>[0],
      { cfg: { channels: { line } } } as Parameters<typeof onMessage>[1],
    );
  } finally {
    await monitor.stop();
  }

  return resolvedTurn?.replyOptions?.disableBlockStreaming;
}

describe("the channel-scoped block streaming choice", () => {
  it("lets a named account override the channel-wide choice", async () => {
    expect(
      await disableBlockStreamingFor({
        streaming: { block: { enabled: true } },
        accounts: { default: { streaming: { block: { enabled: false } } } },
      }),
    ).toBe(true);
  });

  it("keeps a channel-wide disable when an account only tunes coalescing", async () => {
    // A shallow account merge must not erase the channel's explicit disable.
    expect(
      await disableBlockStreamingFor({
        streaming: { block: { enabled: false } },
        accounts: { default: { streaming: { block: { coalesce: { idleMs: 1000 } } } } },
      }),
    ).toBe(true);
  });

  it("reads the choice from the turn's own config, not the one the provider started with", async () => {
    expect(
      await disableBlockStreamingFor(
        { streaming: { block: { enabled: true } } },
        { streaming: { block: { enabled: false } } },
      ),
    ).toBe(false);
  });
});

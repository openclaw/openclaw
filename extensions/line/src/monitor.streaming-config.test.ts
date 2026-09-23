// Line tests cover the channel-scoped block streaming choice reaching the turn.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type LineHandleWebhook = ReturnType<typeof import("./bot.js").createLineBot>["handleWebhook"];
type LineBotOptions = Parameters<typeof import("./bot.js").createLineBot>[0];

const {
  createLineBotMock,
  createLineNodeWebhookHandlerMock,
  registerWebhookTargetWithPluginRouteMock,
} = vi.hoisted(() => ({
  createLineBotMock: vi.fn((_options: LineBotOptions) => ({
    account: { accountId: "default" },
    handleWebhook: vi.fn<LineHandleWebhook>().mockResolvedValue("durable"),
    stop: vi.fn(async () => {}),
  })),
  createLineNodeWebhookHandlerMock: vi.fn(() => async () => {}),
  registerWebhookTargetWithPluginRouteMock: vi.fn(),
}));

vi.mock("./bot.js", () => ({ createLineBot: createLineBotMock }));

vi.mock("openclaw/plugin-sdk/reply-runtime", () => ({
  chunkMarkdownText: vi.fn(),
  dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
}));

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

// The provider builds a real node webhook handler and hands work to the detached
// webhook runner; leaving either unmocked keeps the worker alive after the test ends.
vi.mock("./webhook-node.js", async () => {
  const actual = await vi.importActual<typeof import("./webhook-node.js")>("./webhook-node.js");
  return { ...actual, createLineNodeWebhookHandler: createLineNodeWebhookHandlerMock };
});

vi.mock("openclaw/plugin-sdk/webhook-request-guards", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/webhook-request-guards")>(
    "openclaw/plugin-sdk/webhook-request-guards",
  );
  return { ...actual, runDetachedWebhookWork: vi.fn() };
});

vi.mock("./auto-reply-delivery.js", () => ({ deliverLineAutoReply: vi.fn() }));
vi.mock("./markdown-to-line.js", () => ({ processLineMessage: vi.fn() }));
vi.mock("./send.js", () => ({
  createFlexMessage: vi.fn(),
  createImageMessage: vi.fn(),
  createLocationMessage: vi.fn(),
  getUserDisplayName: vi.fn(),
  pushMessagesLine: vi.fn(),
  replyMessageLine: vi.fn(),
  showLoadingAnimation: vi.fn(),
}));
vi.mock("./template-messages.js", () => ({ buildTemplateMessageFromPayload: vi.fn() }));

const { monitorLineProvider } = await import("./monitor.js");
const { setLineRuntime } = await import("./runtime.js");

type ResolvedTurn = { replyOptions?: { disableBlockStreaming?: boolean } };

afterAll(() => {
  vi.doUnmock("./bot.js");
  vi.doUnmock("openclaw/plugin-sdk/reply-runtime");
  vi.doUnmock("openclaw/plugin-sdk/runtime-env");
  vi.doUnmock("openclaw/plugin-sdk/webhook-ingress");
  vi.doUnmock("openclaw/plugin-sdk/webhook-request-guards");
  vi.doUnmock("./webhook-node.js");
  vi.doUnmock("./auto-reply-delivery.js");
  vi.doUnmock("./markdown-to-line.js");
  vi.doUnmock("./send.js");
  vi.doUnmock("./template-messages.js");
  vi.resetModules();
});

beforeEach(() => {
  createLineBotMock.mockClear();
  createLineNodeWebhookHandlerMock.mockClear();
  // The provider unregisters its route on stop, so the double has to hand one back.
  registerWebhookTargetWithPluginRouteMock
    .mockReset()
    .mockImplementation((params: { target: { path: string } }) => ({
      target: params.target,
      unregister: () => {},
    }));
});

/** Runs one inbound turn and returns the reply options the agent would receive. */
async function replyOptionsFor(params: {
  /** Config the provider was started with. */
  startupConfig?: OpenClawConfig;
  /** Config admission resolved for this event. */
  turnConfig: OpenClawConfig;
}): Promise<ResolvedTurn["replyOptions"]> {
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
    config: params.startupConfig ?? ({} as OpenClawConfig),
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
      { cfg: params.turnConfig } as Parameters<typeof onMessage>[1],
    );
  } finally {
    // A leaked registration makes later shared-path signature tests ambiguous.
    await monitor.stop();
  }

  return resolvedTurn?.replyOptions;
}

function lineCfg(streaming?: unknown): OpenClawConfig {
  return { channels: { line: streaming ? { streaming } : {} } } as OpenClawConfig;
}

describe("the channel-scoped block streaming choice", () => {
  it("turns block replies on for LINE alone when the operator enables them", async () => {
    const replyOptions = await replyOptionsFor({
      turnConfig: lineCfg({ block: { enabled: true } }),
    });

    // false is what core reads as "this channel says yes", overriding the agent default.
    expect(replyOptions?.disableBlockStreaming).toBe(false);
  });

  it("turns block replies off for LINE alone when the operator disables them", async () => {
    const replyOptions = await replyOptionsFor({
      turnConfig: lineCfg({ block: { enabled: false } }),
    });

    expect(replyOptions?.disableBlockStreaming).toBe(true);
  });

  it("stays silent when the operator expressed no channel-scoped choice", async () => {
    // Sending a boolean here would override agents.defaults.blockStreamingDefault
    // for every LINE turn, which is the one thing an unset key must not do.
    const replyOptions = await replyOptionsFor({ turnConfig: lineCfg() });

    expect(replyOptions?.disableBlockStreaming).toBeUndefined();
  });

  it("stays silent when the operator only tuned coalescing", async () => {
    const replyOptions = await replyOptionsFor({
      turnConfig: lineCfg({ block: { coalesce: { minChars: 1500 } } }),
    });

    expect(replyOptions?.disableBlockStreaming).toBeUndefined();
  });

  it("lets a named account override the channel-wide choice", async () => {
    const replyOptions = await replyOptionsFor({
      turnConfig: {
        channels: {
          line: {
            streaming: { block: { enabled: true } },
            accounts: { default: { streaming: { block: { enabled: false } } } },
          },
        },
      } as OpenClawConfig,
    });

    expect(replyOptions?.disableBlockStreaming).toBe(true);
  });

  it("forgets a choice the operator removed since the provider started", async () => {
    // Only this case separates reading the live config from reading the startup one:
    // an inverted or account-blind read still answers undefined here, so a failure
    // names the config source alone.
    const replyOptions = await replyOptionsFor({
      startupConfig: lineCfg({ block: { enabled: false } }),
      turnConfig: lineCfg(),
    });

    expect(replyOptions?.disableBlockStreaming).toBeUndefined();
  });

  it("keeps a channel-wide disable when an account only tunes coalescing", async () => {
    // Account config is merged shallowly, so the account's streaming object replaces
    // the channel's outright. Reading only the merged view would lose the disable and
    // hand the turn back to an agent default of "on".
    const replyOptions = await replyOptionsFor({
      turnConfig: {
        channels: {
          line: {
            streaming: { block: { enabled: false } },
            accounts: { default: { streaming: { block: { coalesce: { idleMs: 1000 } } } } },
          },
        },
      } as OpenClawConfig,
    });

    expect(replyOptions?.disableBlockStreaming).toBe(true);
  });

  it("keeps a channel-wide enable when an account only sets a chunk mode", async () => {
    const replyOptions = await replyOptionsFor({
      turnConfig: {
        channels: {
          line: {
            streaming: { block: { enabled: true } },
            accounts: { default: { streaming: { chunkMode: "newline" } } },
          },
        },
      } as OpenClawConfig,
    });

    expect(replyOptions?.disableBlockStreaming).toBe(false);
  });

  it("reads the choice from the turn's own config, not the one the provider started with", async () => {
    // LINE resolves config per event so a hot-applied change reaches the next turn.
    // Reading the startup snapshot here would silently pin the streaming choice to
    // whatever was configured when the provider was created.
    const replyOptions = await replyOptionsFor({
      startupConfig: lineCfg({ block: { enabled: false } }),
      turnConfig: lineCfg({ block: { enabled: true } }),
    });

    expect(replyOptions?.disableBlockStreaming).toBe(false);
  });
});

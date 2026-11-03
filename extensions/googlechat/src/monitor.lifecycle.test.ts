import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

type IngressOptions = { dispatch: (event: GoogleChatEvent) => Promise<void> };
const mocks = vi.hoisted(() => ({
  ingressStart: vi.fn(),
  ingressStop: vi.fn(async () => undefined),
  registerTarget: vi.fn((_target: WebhookTarget) => vi.fn()),
  ingressFactory: vi.fn<(params: IngressOptions) => void>(),
  runTurn: vi.fn<(params: { adapter: { resolveTurn: () => { cfg: OpenClawConfig } } }) => void>(),
}));

// mock-isolation: Lifecycle tests own ingress start/stop and dispatch without a live channel queue.
vi.mock("./monitor-ingress.js", () => ({
  createGoogleChatIngressMonitor: (params: IngressOptions) => {
    mocks.ingressFactory(params);
    return {
      receive: vi.fn(),
      start: mocks.ingressStart,
      stop: mocks.ingressStop,
    };
  },
}));

// mock-isolation: Capture target registration without installing process-wide webhook routes.
vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: mocks.registerTarget,
  setGoogleChatWebhookEventProcessor: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getGoogleChatRuntime: () => ({
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: { buildContext: (payload: unknown) => payload, run: mocks.runTurn },
    },
  }),
}));

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: async () => ({ ok: true }),
}));

import { startGoogleChatMonitor } from "./monitor.js";

const defaultAudience = { audienceType: "project-number", audience: "1234567890" };

function start(
  accountConfig: typeof defaultAudience & {
    typingIndicator?: "none";
  } = defaultAudience,
  overrides: Partial<Parameters<typeof startGoogleChatMonitor>[0]> = {},
) {
  return startGoogleChatMonitor({
    account: { accountId: "default", config: accountConfig },
    config: {},
    runtime: {},
    abortSignal: new AbortController().signal,
    webhookPath: "/googlechat",
    ...overrides,
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.registerTarget.mockReturnValue(vi.fn());
});

afterEach(clearRuntimeConfigSnapshot);

it.each([
  defaultAudience,
  { audienceType: "app-url", audience: "https://chat.example.test/googlechat" },
])("reloads $audienceType config with the same target", async (audience) => {
  const startup = { messages: { visibleReplies: "message_tool" as const } };
  setRuntimeConfigSnapshot(startup);
  const statusSink = vi.fn();
  const stop = await start(
    { ...audience, typingIndicator: "none" },
    { config: startup, statusSink },
  );
  try {
    const target = mocks.registerTarget.mock.calls[0]![0];
    expect(mocks.registerTarget).toHaveBeenCalledOnce();
    expect(target).toMatchObject(audience);
    expect(statusSink).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
    const { dispatch } = mocks.ingressFactory.mock.calls[0]![0];
    const event: GoogleChatEvent = {
      type: "MESSAGE",
      space: { name: "spaces/CONFIG", type: "DM" },
      message: {
        name: "spaces/CONFIG/messages/1",
        text: "hello",
        sender: { name: "users/alice" },
      },
    };
    await dispatch(event);
    setRuntimeConfigSnapshot({ messages: { visibleReplies: "automatic" } });
    await dispatch(event);
    expect(
      mocks.runTurn.mock.calls.map(
        ([turn]) => turn.adapter.resolveTurn().cfg.messages?.visibleReplies,
      ),
    ).toEqual(["message_tool", "automatic"]);
    expect(target.config).toBe(startup);
    expect(mocks.ingressStart).toHaveBeenCalledOnce();
  } finally {
    await stop();
  }
});

it.each([
  ["the audience is blank", "app-url", "   "],
  ["the audience type is unsupported", "unsupported", "https://chat.example.test/googlechat"],
])("blocks startup when %s", async (_description, audienceType, audience) => {
  const statusSink = vi.fn();
  const runtime = { error: vi.fn() };

  const stop = await start({ audienceType, audience }, { runtime, statusSink });

  expect(mocks.ingressStart).not.toHaveBeenCalled();
  expect(mocks.registerTarget).not.toHaveBeenCalled();
  expect(statusSink).toHaveBeenCalledWith({
    lifecycle: "blocked",
    terminalDisconnect: true,
    running: true,
    connected: false,
    webhookPath: undefined,
    lastError: expect.stringContaining("channels.googlechat.audienceType"),
  });
  await expect(stop()).resolves.toBeUndefined();
  expect(mocks.ingressStop).not.toHaveBeenCalled();
});

it("stops ingress and rejects startup when the webhook route cannot bind", async () => {
  const statusSink = vi.fn();
  mocks.registerTarget.mockImplementationOnce(() => {
    throw new Error("Google Chat route conflict");
  });

  await expect(start(defaultAudience, { statusSink })).rejects.toThrow(
    "Google Chat route conflict",
  );

  expect(mocks.ingressStart).toHaveBeenCalledOnce();
  expect(mocks.ingressStop).toHaveBeenCalledOnce();
  expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
});

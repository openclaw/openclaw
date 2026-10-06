// Google Chat tests cover monitor lifecycle status publication.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebhookTarget } from "./monitor-types.js";
import type { GoogleChatEvent } from "./types.js";

const mocks = vi.hoisted(() => ({
  ingressStart: vi.fn(),
  ingressStop: vi.fn(async () => undefined),
  registerTarget: vi.fn((_target: WebhookTarget) => vi.fn()),
  setProcessor: vi.fn(),
  ingressFactory:
    vi.fn<(params: { dispatch: (event: GoogleChatEvent) => Promise<void> }) => void>(),
  runTurn: vi.fn<(params: { adapter: { resolveTurn: () => { cfg: OpenClawConfig } } }) => void>(),
}));

vi.mock("./monitor-ingress.js", () => ({
  createGoogleChatIngressMonitor: (params: {
    dispatch: (event: GoogleChatEvent) => Promise<void>;
  }) => {
    mocks.ingressFactory(params);
    return {
      receive: vi.fn(),
      start: mocks.ingressStart,
      stop: mocks.ingressStop,
    };
  },
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: mocks.registerTarget,
  setGoogleChatWebhookEventProcessor: mocks.setProcessor,
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

const configuredAccount = {
  accountId: "default",
  enabled: true,
  credentialSource: "config",
  config: {
    audienceType: "project-number",
    audience: "1234567890",
  },
};

describe("Google Chat monitor lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.registerTarget.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it.each([true, false])(
    "follows runtime reloads only for a runtime-owned monitor (runtimeOwned=%s)",
    async (runtimeOwned) => {
      const startup = { messages: { visibleReplies: "message_tool" as const } };
      setRuntimeConfigSnapshot(runtimeOwned ? startup : {});
      const stop = await startGoogleChatMonitor({
        account: {
          ...configuredAccount,
          config: { ...configuredAccount.config, typingIndicator: "none" },
        },
        config: startup,
        runtime: {},
        abortSignal: new AbortController().signal,
      } as never);
      try {
        const target = mocks.registerTarget.mock.calls[0]![0];
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
        ).toEqual(["message_tool", runtimeOwned ? "automatic" : "message_tool"]);
        expect(target.config).toBe(startup);
        expect(target.audience).toBe("1234567890");
        expect(mocks.ingressStart).toHaveBeenCalledOnce();
      } finally {
        await stop();
      }
    },
  );

  it.each([
    { audienceType: "app-url", audience: "https://chat.example.test/googlechat" },
    { audienceType: "project-number", audience: "1234567890" },
  ])("publishes ready after the $audienceType webhook target is registered", async (config) => {
    const statusSink = vi.fn();

    const stop = await startGoogleChatMonitor({
      account: { ...configuredAccount, config },
      config: {},
      runtime: {},
      abortSignal: new AbortController().signal,
      webhookPath: "/googlechat",
      statusSink,
    } as never);

    expect(mocks.registerTarget).toHaveBeenCalledOnce();
    expect(mocks.registerTarget).toHaveBeenCalledWith(expect.objectContaining(config));
    expect(statusSink).toHaveBeenCalledWith({
      running: true,
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: expect.any(Number),
      lastError: null,
      terminalDisconnect: undefined,
    });
    await stop();
  });

  it.each([
    {
      description: "the audience is blank",
      config: { audienceType: "app-url", audience: "   " },
    },
    {
      description: "the audience type is missing",
      config: { audience: "https://chat.example.test/googlechat" },
    },
    {
      description: "the audience type is unsupported",
      config: {
        audienceType: "unsupported",
        audience: "https://chat.example.test/googlechat",
      },
    },
  ])("blocks startup when $description", async ({ config }) => {
    const statusSink = vi.fn();
    const runtime = { error: vi.fn() };

    const stop = await startGoogleChatMonitor({
      account: { ...configuredAccount, config },
      config: {},
      runtime,
      abortSignal: new AbortController().signal,
      webhookPath: "/googlechat",
      statusSink,
    } as never);

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
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("channels.googlechat.audience"),
    );
    await expect(stop()).resolves.toBeUndefined();
    expect(mocks.ingressStop).not.toHaveBeenCalled();
  });

  it("stops ingress and rejects startup when the webhook route cannot bind", async () => {
    const statusSink = vi.fn();
    mocks.registerTarget.mockImplementationOnce(() => {
      throw new Error("Google Chat route conflict");
    });

    await expect(
      startGoogleChatMonitor({
        account: configuredAccount,
        config: {},
        runtime: {},
        abortSignal: new AbortController().signal,
        webhookPath: "/googlechat",
        statusSink,
      } as never),
    ).rejects.toThrow("Google Chat route conflict");

    expect(mocks.ingressStart).toHaveBeenCalledOnce();
    expect(mocks.ingressStop).toHaveBeenCalledOnce();
    expect(statusSink).not.toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
  });
});

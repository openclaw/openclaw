import { join } from "node:path";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelInboundEventRunnerParams } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TwitchConfigSchema } from "./config-schema.js";
import { BASE_TWITCH_TEST_ACCOUNT } from "./test-fixtures.js";
import type { createTwitchIngress } from "./twitch-ingress.js";
import type { TwitchChatMessage } from "./types.js";

const mocks = vi.hoisted(() => ({
  checkAccess: vi.fn(async () => ({ allowed: true })),
  createIngress: vi.fn(),
  getClient: vi.fn(async () => ({})),
  getRuntime: vi.fn(),
  ingressAccept: vi.fn<(message: TwitchChatMessage) => Promise<void>>(),
  ingressStart: vi.fn(),
  ingressStop: vi.fn<() => Promise<void>>(),
  onMessage: vi.fn(),
  runInbound: vi.fn(),
  sendMessage: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock("./access-control.js", () => ({ checkTwitchAccessControl: mocks.checkAccess }));

vi.mock("./client-manager-registry.js", () => ({
  getOrCreateClientManager: () => ({
    getClient: mocks.getClient,
    onMessage: mocks.onMessage,
    sendMessage: mocks.sendMessage,
  }),
}));

vi.mock("./runtime.js", () => ({ getTwitchRuntime: mocks.getRuntime }));

vi.mock("./twitch-ingress.js", () => ({ createTwitchIngress: mocks.createIngress }));

import { monitorTwitchProvider } from "./monitor.js";

type InboundRunInput = {
  raw: TwitchChatMessage;
  adapter: {
    ingest: (message: TwitchChatMessage) => unknown;
    resolveTurn: (input: unknown) => Promise<{
      delivery: {
        deliver: (payload: ReplyPayload) => Promise<{ visibleReplySent: boolean }>;
        onDelivered: (
          payload: ReplyPayload,
          info: { kind: "final" },
          result: { visibleReplySent: boolean },
        ) => void;
      };
    }>;
  };
};

describe("monitorTwitchProvider", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "twitch-prefix-");
  const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:test-token" };

  async function startMonitor(
    config: OpenClawConfig,
    statusSink?: Parameters<typeof monitorTwitchProvider>[0]["statusSink"],
  ) {
    const runtimeError = vi.fn();
    mocks.onMessage.mockReturnValue(mocks.unregister);
    const monitor = await monitorTwitchProvider({
      account,
      accountId: "default",
      config,
      channelRuntime: mocks.getRuntime().channel,
      runtime: { error: runtimeError },
      abortSignal: new AbortController().signal,
      statusSink,
    });
    return { monitor, runtimeError };
  }

  async function dispatchMessage(id: string) {
    mocks.onMessage.mock.calls[0]?.[0]({
      id,
      username: "viewer",
      userId: "viewer-1",
      message: "hello bot",
      channel: "testchannel",
    });
    expect(mocks.ingressAccept).toHaveBeenCalledOnce();
    // Join native delivery, including cold dispatcher startup.
    await mocks.ingressAccept.mock.results[0]?.value;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getClient.mockResolvedValue({});
    mocks.sendMessage.mockResolvedValue({ ok: true, messageId: "message-id" });
    mocks.ingressStop.mockImplementation(async () => {
      await Promise.allSettled(mocks.ingressAccept.mock.results.map((result) => result.value));
    });
    mocks.createIngress.mockImplementation(
      (options: Parameters<typeof createTwitchIngress>[0]) => ({
        accept: mocks.ingressAccept.mockImplementation(async (message: TwitchChatMessage) => {
          await options.deliver(message, {
            admission: "exclusive",
            abortSignal: new AbortController().signal,
            onAdopted: async () => undefined,
            onDeferred: () => undefined,
            onAbandoned: async () => undefined,
          });
        }),
        start: mocks.ingressStart,
        stop: mocks.ingressStop,
      }),
    );
    mocks.getRuntime.mockReturnValue({
      logging: {
        getChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
        shouldLogVerbose: () => false,
      },
      channel: {
        inbound: {
          run: mocks.runInbound,
          buildContext: vi.fn(() => ({})),
        },
        routing: {
          resolveAgentRoute: vi.fn(() => ({
            agentId: "main",
            accountId: "default",
            sessionKey: "agent:main:twitch:group:testchannel",
          })),
        },
        reply: {
          formatAgentEnvelope: vi.fn(({ body }: { body: string }) => body),
          resolveEnvelopeFormatOptions: vi.fn(() => ({})),
          dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        },
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          recordInboundSession: vi.fn(),
        },
      },
    });
  });

  it.each([
    { name: "single-account root", multi: false, override: undefined, expected: "[root] reply" },
    { name: "multi-account root", multi: true, override: undefined, expected: "[root] reply" },
    { name: "account override", multi: true, override: "[account]", expected: "[account] reply" },
    { name: "empty override", multi: true, override: "", expected: "reply" },
  ])(
    "delivers $name prefixes through the shared dispatcher",
    async ({ name, multi, override, expected }) => {
      const channelConfig = multi
        ? {
            responsePrefix: "[root]",
            accounts: { default: { ...account, responsePrefix: override } },
          }
        : { ...account, responsePrefix: "[root]" };
      expect(
        validateJsonSchemaValue({
          cacheKey: "twitch.monitor-prefix",
          schema: buildChannelConfigSchema(TwitchConfigSchema).schema,
          value: channelConfig,
        }),
      ).toMatchObject({ ok: true });
      const config: OpenClawConfig = {
        session: { store: join(sessionDirs.make(), "sessions.json") },
        messages: { responsePrefix: "[global]" },
        channels: { twitch: channelConfig },
      };
      const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
        "openclaw/plugin-sdk/channel-inbound",
      );
      mocks.getRuntime().channel.inbound.buildContext = actual.buildChannelInboundEventContext;
      mocks.runInbound.mockImplementation(
        (input: ChannelInboundEventRunnerParams<TwitchChatMessage>) =>
          actual.runChannelInboundEvent({
            ...input,
            // This observes native output, not ingress or delivery queue persistence.
            turnAdoptionLifecycle: undefined,
            adapter: {
              ...input.adapter,
              resolveTurn: async (...args) => {
                const turn = await input.adapter.resolveTurn(...args);
                if (!("delivery" in turn)) {
                  throw new Error("Expected a reply delivery turn");
                }
                return {
                  ...turn,
                  delivery: { ...turn.delivery, durable: false },
                  replyResolver: async () => ({ text: "reply" }),
                };
              },
            },
          }),
      );
      const { monitor, runtimeError } = await startMonitor(config);
      try {
        await dispatchMessage(`prefix-${name}`);
        expect(mocks.sendMessage).toHaveBeenCalledOnce();
        expect(mocks.sendMessage).toHaveBeenCalledWith(
          account,
          "testchannel",
          expected,
          config,
          "default",
        );
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    },
  );

  it.each<
    [
      name: string,
      payload: ReplyPayload,
      expectedText: string | undefined,
      expectedVisible: boolean,
      providerError?: string,
      expectedError?: string,
    ]
  >([
    ["plain Markdown text", { text: "**Hello** Twitch" }, "Hello Twitch", true],
    [
      "caption with a legacy media URL",
      { text: "Check this:", mediaUrl: "https://example.com/image.png" },
      "Check this: https://example.com/image.png",
      true,
    ],
    [
      "caption with every attachment URL",
      {
        text: "Files attached:",
        mediaUrls: ["https://example.com/one.png", "https://example.com/two.png"],
      },
      "Files attached: https://example.com/one.png https://example.com/two.png",
      true,
    ],
    [
      "media-only reply",
      { mediaUrl: "https://example.com/image.png" },
      "https://example.com/image.png",
      true,
    ],
    ["empty reply", { text: "" }, undefined, false, undefined, "No text to send in reply payload"],
    [
      "provider send failure",
      { text: "Hello Twitch" },
      "Hello Twitch",
      false,
      "provider unavailable",
      "Failed to send reply: Error: provider unavailable",
    ],
  ])(
    "handles %s through the public monitor boundary",
    async (_name, payload, expectedText, expectedVisible, providerError, expectedError) => {
      const settled = vi.fn();
      const statusSink = vi.fn();
      if (providerError) {
        mocks.sendMessage.mockResolvedValueOnce({ ok: false, error: providerError });
      }
      mocks.runInbound.mockImplementation(async (input: InboundRunInput) => {
        const turn = await input.adapter.resolveTurn(input.adapter.ingest(input.raw));
        const result = await turn.delivery.deliver(payload);
        settled(result);
        turn.delivery.onDelivered(payload, { kind: "final" }, result);
      });
      const config: OpenClawConfig = {
        session: { store: join(sessionDirs.make(), "sessions.json") },
      };
      const { monitor, runtimeError } = await startMonitor(config, statusSink);
      await dispatchMessage("message-1");
      expect(settled).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledWith({ visibleReplySent: expectedVisible });
      if (expectedText) {
        expect(mocks.sendMessage).toHaveBeenCalledWith(
          account,
          "testchannel",
          expectedText,
          config,
          "default",
        );
      } else {
        expect(mocks.sendMessage).not.toHaveBeenCalled();
      }
      if (expectedError) {
        expect(runtimeError).toHaveBeenCalledWith(expectedError);
      } else {
        expect(runtimeError).not.toHaveBeenCalled();
      }
      const outboundStatus = expect.objectContaining({ lastOutboundAt: expect.any(Number) });
      if (expectedVisible) {
        expect(statusSink).toHaveBeenCalledWith(outboundStatus);
      } else {
        expect(statusSink).not.toHaveBeenCalledWith(outboundStatus);
      }

      await monitor.stop();
      expect(mocks.unregister).toHaveBeenCalledOnce();
      expect(mocks.ingressStop).toHaveBeenCalledOnce();
    },
  );
});

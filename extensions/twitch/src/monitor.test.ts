import { join } from "node:path";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { ChannelInboundEventRunnerParams } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
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

vi.mock("./client-manager-registry.js", () => ({
  getOrCreateClientManager: () => ({
    getClient: mocks.getClient,
    onMessage: mocks.onMessage,
    sendMessage: mocks.sendMessage,
  }),
}));

// mock-isolation: Supply the monitor's host runtime without loading the live Gateway.
vi.mock("./runtime.js", () => ({ getTwitchRuntime: mocks.getRuntime }));

// mock-isolation: Observe monitor lifecycle wiring without starting a second ingress owner.
vi.mock("./twitch-ingress.js", () => ({ createTwitchIngress: mocks.createIngress }));

import { monitorTwitchProvider } from "./monitor.js";

type DeliveryCase = [string, ReplyPayload, string | undefined, boolean, string?, string?];

describe("monitorTwitchProvider", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "twitch-prefix-");
  const account = { ...BASE_TWITCH_TEST_ACCOUNT, accessToken: "oauth:test-token" };
  const image = "https://example.com/a";
  const files = [image, "https://example.com/b"];
  const sendError = "Failed to send reply: Error: unavailable";
  function makeConfig(extra: OpenClawConfig = {}): OpenClawConfig {
    return { session: { store: join(sessionDirs.make(), "sessions.json") }, ...extra };
  }
  function expectSend(text: string, config: OpenClawConfig) {
    expect(mocks.sendMessage).toHaveBeenCalledWith(account, "testchannel", text, config, "default");
  }

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
      message: "@testbot hello bot",
      channel: "testchannel",
    });
    expect(mocks.ingressAccept).toHaveBeenCalledOnce();
    // Join native delivery, including cold dispatcher startup.
    await mocks.ingressAccept.mock.results[0]?.value;
  }

  beforeEach(() => {
    vi.clearAllMocks();
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
          ingress: createPluginRuntimeMock().channel.inbound.ingress,
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
      const config = makeConfig({
        messages: { responsePrefix: "[global]" },
        channels: { twitch: channelConfig },
      });
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
        expectSend(expected, config);
        expect(runtimeError).not.toHaveBeenCalled();
      } finally {
        await monitor.stop();
      }
    },
  );

  it.each<DeliveryCase>([
    ["Markdown", { text: "**Hello** Twitch" }, "Hello Twitch", true],
    ["legacy media caption", { text: "See:", mediaUrl: image }, `See: ${image}`, true],
    ["all attachments", { text: "Files:", mediaUrls: files }, `Files: ${files.join(" ")}`, true],
    ["media only", { mediaUrl: image }, image, true],
    ["empty", { text: "" }, undefined, false, undefined, "No text to send in reply payload"],
    ["send failure", { text: "Hi" }, "Hi", false, "unavailable", sendError],
  ])(
    "handles %s through the public monitor boundary",
    async (_name, payload, expectedText, expectedVisible, providerError, expectedError) => {
      const settled = vi.fn();
      const statusSink = vi.fn();
      if (providerError) {
        mocks.sendMessage.mockResolvedValueOnce({ ok: false, error: providerError });
      }
      mocks.runInbound.mockImplementation(
        async (input: ChannelInboundEventRunnerParams<TwitchChatMessage>) => {
          const normalized = await input.adapter.ingest(input.raw);
          if (!normalized) {
            throw new Error("Expected a normalized message");
          }
          const turn = await input.adapter.resolveTurn(
            normalized,
            { kind: "message", canStartAgentTurn: true },
            {},
          );
          if (!("delivery" in turn)) {
            throw new Error("Expected a reply delivery turn");
          }
          const result = await turn.delivery.deliver(payload, { kind: "final" });
          settled(result);
          expect(turn.delivery.onDelivered).toBeTypeOf("function");
          await turn.delivery.onDelivered?.(payload, { kind: "final" }, result);
        },
      );
      const config = makeConfig();
      const { monitor, runtimeError } = await startMonitor(config, statusSink);
      await dispatchMessage("message-1");
      expect(settled.mock.calls).toEqual([[{ visibleReplySent: expectedVisible }]]);
      if (expectedText) {
        expectSend(expectedText, config);
      } else {
        expect(mocks.sendMessage).not.toHaveBeenCalled();
      }
      expect(runtimeError.mock.calls).toEqual(expectedError ? [[expectedError]] : []);
      expect(statusSink.mock.calls.filter(([patch]) => "lastOutboundAt" in patch)).toEqual(
        expectedVisible ? [[{ lastOutboundAt: expect.any(Number) }]] : [],
      );
      await monitor.stop();
      expect(mocks.unregister).toHaveBeenCalledOnce();
      expect(mocks.ingressStop).toHaveBeenCalledOnce();
    },
  );
});

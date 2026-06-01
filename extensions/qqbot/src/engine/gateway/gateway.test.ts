import { describe, expect, it, vi } from "vitest";
import type { EngineAdapters } from "../adapter/index.js";
import { startGateway } from "./gateway.js";
import type { CoreGatewayContext, GatewayPluginRuntime } from "./types.js";

function createContext(account: Partial<CoreGatewayContext["account"]> = {}): CoreGatewayContext {
  const runtime: GatewayPluginRuntime = {
    channel: {
      activity: { record: vi.fn() },
      routing: { resolveAgentRoute: vi.fn() },
      reply: {
        dispatchReplyWithBufferedBlockDispatcher: vi.fn(),
        resolveEffectiveMessagesConfig: vi.fn(() => ({})),
        finalizeInboundContext: vi.fn(),
        formatInboundEnvelope: vi.fn(),
        resolveEnvelopeFormatOptions: vi.fn(),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/qqbot-session.jsonl"),
        recordInboundSession: vi.fn(),
      },
      inbound: { run: vi.fn() },
      text: { chunkMarkdownText: vi.fn((text: string) => [text]) },
    },
    tts: {
      textToSpeech: vi.fn(async () => ({ success: false })),
    },
  };

  const adapters: EngineAdapters = {
    history: {} as EngineAdapters["history"],
    mentionGate: {} as EngineAdapters["mentionGate"],
    access: {} as EngineAdapters["access"],
    audioConvert: {} as EngineAdapters["audioConvert"],
    outboundAudio: {} as EngineAdapters["outboundAudio"],
    commands: {
      resolveVersion: () => "test",
      pluginVersion: "test",
    },
  };

  return {
    account: {
      accountId: "qqbot",
      appId: "",
      clientSecret: "",
      markdownSupport: false,
      config: {},
      ...account,
    },
    cfg: {},
    log: { info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    runtime,
    adapters,
    abortSignal: new AbortController().signal,
  };
}

describe("QQBot gateway configuration errors", () => {
  it("throws actionable setup guidance when credentials are missing", async () => {
    await expect(startGateway(createContext())).rejects.toThrow(
      /QQBot not configured.*QQBOT_APP_ID.*QQBOT_CLIENT_SECRET.*openclaw configure.*https:\/\/q\.qq\.com\/.*https:\/\/docs\.openclaw\.ai\/channels\/qqbot/,
    );
  });

  it("points named accounts at account-scoped credentials", async () => {
    await expect(
      startGateway(createContext({ accountId: "ops", appId: "app-id" })),
    ).rejects.toThrow(
      /QQBot account "ops" is not configured.*channels\.qqbot\.accounts\.ops\.appId.*channels\.qqbot\.accounts\.ops\.clientSecret.*QQBOT_APP_ID.*default QQBot account/,
    );
  });
});

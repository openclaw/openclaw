// Qa Lab tests cover Crabline transport integration behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import {
  createQaCrablineTransportAdapter,
  type QaCrablineProviderAdapter,
} from "./crabline-transport.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function createTempOutputDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-crabline-transport-"));
  tempDirs.push(dir);
  return dir;
}

function createSelection() {
  return {
    capabilityMatrixPath: "crabline-channel-capability-matrix.json",
    channel: "telegram",
    channelDriver: "crabline",
    smokeArtifactPath: "crabline-channel-smoke.json",
  } as const;
}

function createEnv() {
  return {
    OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN: "driver-token",
    OPENCLAW_QA_TELEGRAM_GROUP_ID: "-100123",
    OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN: "sut-token",
  } satisfies NodeJS.ProcessEnv;
}

function createProvider(overrides: Partial<QaCrablineProviderAdapter> = {}) {
  const provider = {
    id: "telegram",
    platform: "telegram",
    status: "ready",
    supports: ["probe", "send", "roundtrip", "agent"],
    normalizeTarget: vi.fn((target) => ({ id: target.id, metadata: target.metadata })),
    probe: vi.fn(async () => ({ details: [], healthy: true })),
    send: vi.fn(async () => ({
      accepted: true,
      messageId: "driver-message-1",
      threadId: "telegram:-100123",
    })),
    waitForInbound: vi
      .fn()
      .mockResolvedValueOnce({
        author: "assistant",
        id: "sut-message-1",
        provider: "telegram",
        sentAt: new Date().toISOString(),
        text: "QA-DM-BASELINE-OK reply",
        threadId: "telegram:-100123",
      })
      .mockResolvedValue(null),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  } satisfies QaCrablineProviderAdapter;
  return provider;
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}

function createConvexCredentialFetch() {
  return vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = fetchInputUrl(input);
    if (url.endsWith("/acquire")) {
      return new Response(
        JSON.stringify({
          status: "ok",
          credentialId: "telegram-credential-1",
          leaseToken: "lease-token-1",
          payload: {
            driverToken: "driver-token-from-convex",
            groupId: "-100456",
            sutToken: "sut-token-from-convex",
          },
          heartbeatIntervalMs: 60_000,
          leaseTtlMs: 600_000,
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/release") || url.endsWith("/heartbeat")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return new Response(JSON.stringify({ status: "error", code: "not_found" }), { status: 404 });
  });
}

describe("crabline transport", () => {
  it("configures the Telegram gateway account for the SUT bot", async () => {
    const transport = await createQaCrablineTransportAdapter({
      env: createEnv(),
      outputDir: await createTempOutputDir(),
      runtime: {
        fetchTelegramBotIdentity: vi.fn(async () => ({
          first_name: "Driver",
          id: 42,
          is_bot: true,
          username: "driver_bot",
        })),
        provider: createProvider(),
      },
      selection: createSelection(),
      state: createQaBusState(),
    });

    expect(transport.id).toBe("crabline");
    expect(transport.createChannelDriverSmokeEnv?.({}).TELEGRAM_BOT_TOKEN).toBe("driver-token");
    expect(transport.requiredPluginIds).toEqual(["telegram"]);
    expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
      channels: {
        telegram: {
          accounts: {
            "qa-crabline-sut": {
              botToken: "sut-token",
              groups: {
                "-100123": {
                  allowFrom: ["42"],
                  requireMention: true,
                },
              },
            },
          },
        },
      },
      messages: {
        groupChat: {
          mentionPatterns: ["\\b@?openclaw\\b"],
        },
      },
    });
    await transport.cleanup?.();
  });

  it("acquires Telegram credentials through the Convex broker for CI runs", async () => {
    const fetchCredentialLease = createConvexCredentialFetch();
    const fetchTelegramBotIdentity = vi.fn(async (token: string) => {
      expect(token).toBe("driver-token-from-convex");
      return {
        first_name: "Driver",
        id: 42,
        is_bot: true,
        username: "driver_bot",
      };
    });
    const transport = await createQaCrablineTransportAdapter({
      env: {
        OPENCLAW_QA_CONVEX_SECRET_CI: "convex-secret",
        OPENCLAW_QA_CONVEX_SITE_URL: "https://qa-credentials.example.convex.site",
        OPENCLAW_QA_CREDENTIAL_ROLE: "ci",
        OPENCLAW_QA_CREDENTIAL_SOURCE: "convex",
      },
      outputDir: await createTempOutputDir(),
      runtime: {
        fetchCredentialLease,
        fetchTelegramBotIdentity,
        provider: createProvider(),
      },
      selection: createSelection(),
      state: createQaBusState(),
    });

    expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
      channels: {
        telegram: {
          accounts: {
            "qa-crabline-sut": {
              botToken: "sut-token-from-convex",
              groups: {
                "-100456": {
                  allowFrom: ["42"],
                },
              },
            },
          },
        },
      },
    });

    expect(transport.createChannelDriverSmokeEnv?.({}).TELEGRAM_BOT_TOKEN).toBe(
      "driver-token-from-convex",
    );
    await transport.cleanup?.();
    expect(fetchCredentialLease.mock.calls.map(([input]) => fetchInputUrl(input))).toEqual(
      expect.arrayContaining([
        "https://qa-credentials.example.convex.site/qa-credentials/v1/acquire",
        "https://qa-credentials.example.convex.site/qa-credentials/v1/release",
      ]),
    );
  });

  it("sends scenario inbound messages through Crabline and mirrors observed replies", async () => {
    const provider = createProvider();
    const transport = await createQaCrablineTransportAdapter({
      env: createEnv(),
      observeIdleMs: 1,
      observeTimeoutMs: 200,
      outputDir: await createTempOutputDir(),
      runtime: {
        fetchTelegramBotIdentity: vi.fn(async () => ({
          first_name: "Driver",
          id: 42,
          is_bot: true,
          username: "driver_bot",
        })),
        provider,
      },
      selection: createSelection(),
      state: createQaBusState(),
    });

    await transport.state.addInboundMessage({
      conversation: {
        id: "alice",
        kind: "direct",
      },
      senderId: "alice",
      senderName: "Alice",
      text: "DM baseline marker check.",
    });

    await transport.state.waitFor({
      direction: "outbound",
      kind: "message-text",
      textIncludes: "QA-DM-BASELINE-OK",
      timeoutMs: 500,
    });

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "agent",
        text: "@openclaw DM baseline marker check.",
      }),
    );
    expect(transport.state.getSnapshot().messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          conversation: expect.objectContaining({
            id: "alice",
            kind: "direct",
          }),
          direction: "outbound",
          text: "QA-DM-BASELINE-OK reply",
        }),
      ]),
    );
    await transport.cleanup?.();
    expect(provider.cleanup).toHaveBeenCalled();
  });

  it("fails fast when a non-Telegram Crabline channel is selected", async () => {
    await expect(
      createQaCrablineTransportAdapter({
        env: createEnv(),
        outputDir: await createTempOutputDir(),
        selection: {
          ...createSelection(),
          channel: "slack",
        },
        state: createQaBusState(),
      }),
    ).rejects.toThrow("Crabline channel slack is not supported");
  });
});

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

function createSelection(channel = "telegram") {
  return {
    capabilityMatrixPath: "crabline-channel-capability-matrix.json",
    channel,
    channelDriver: "crabline",
    smokeArtifactPath: "crabline-channel-smoke.json",
  } as const;
}

function createProvider(overrides: Partial<QaCrablineProviderAdapter> = {}) {
  const provider = {
    id: "telegram",
    platform: "telegram",
    status: "ready",
    supports: ["probe", "send", "roundtrip", "agent"],
    normalizeTarget: vi.fn((target) => ({ id: target.id, metadata: target.metadata })),
    probe: vi.fn(async () => ({ details: [], healthy: true })),
    send: vi.fn(async (params) => ({
      accepted: true,
      messageId: "driver-message-1",
      threadId: `${params.providerId}:dm:alice`,
    })),
    waitForInbound: vi
      .fn()
      .mockResolvedValueOnce({
        author: "assistant",
        id: "mock-message-1",
        provider: "telegram",
        sentAt: new Date().toISOString(),
        text: "[telegram mock] DM baseline marker check.",
        threadId: "telegram:dm:alice",
      })
      .mockResolvedValue(null),
    cleanup: vi.fn(async () => {}),
    ...overrides,
  } satisfies QaCrablineProviderAdapter;
  return provider;
}

describe("crabline transport", () => {
  it("configures a Crabline transport without live channel plugins or secrets", async () => {
    const outputDir = await createTempOutputDir();
    const transport = await createQaCrablineTransportAdapter({
      env: {},
      outputDir,
      runtime: {
        provider: createProvider(),
      },
      selection: createSelection(),
      state: createQaBusState(),
    });

    expect(transport.id).toBe("crabline");
    expect(transport.requiredPluginIds).toEqual(["qa-channel"]);
    expect(transport.createGatewayConfig({ baseUrl: "http://127.0.0.1:1" })).toMatchObject({
      channels: {
        "qa-channel": {
          baseUrl: "http://127.0.0.1:1",
          enabled: true,
        },
      },
    });
    expect(transport.createChannelDriverSmokeEnv?.({})).toEqual({});
    expect(transport.buildAgentDelivery({ target: "dm:alice" })).toEqual({
      channel: "qa-channel",
      replyChannel: "qa-channel",
      replyTo: "dm:alice",
    });

    const manifest = JSON.parse(
      await fs.readFile(path.join(outputDir, "crabline-runtime.json"), "utf8"),
    ) as {
      providers?: Record<string, unknown>;
    };
    expect(manifest.providers).toHaveProperty("telegram");
    await transport.cleanup?.();
  });

  it("supports non-Telegram Crabline mock channels", async () => {
    const provider = createProvider({
      send: vi.fn(async () => ({
        accepted: true,
        messageId: "slack-send-1",
        threadId: "slack:dm:alice",
      })),
      waitForInbound: vi.fn(async () => null),
    });
    const outputDir = await createTempOutputDir();
    const transport = await createQaCrablineTransportAdapter({
      outputDir,
      runtime: { provider },
      selection: createSelection("slack"),
      state: createQaBusState(),
    });

    expect(transport.label).toBe("crabline + slack");
    expect(transport.buildAgentDelivery({ target: "channel:C123" })).toEqual({
      channel: "qa-channel",
      replyChannel: "qa-channel",
      replyTo: "channel:C123",
    });
    const manifest = JSON.parse(
      await fs.readFile(path.join(outputDir, "crabline-runtime.json"), "utf8"),
    ) as {
      providers?: Record<string, unknown>;
    };
    expect(manifest.providers).toHaveProperty("slack");
    await transport.cleanup?.();
  });

  it("records scenario inbound messages through Crabline without synthetic replies", async () => {
    const provider = createProvider();
    const transport = await createQaCrablineTransportAdapter({
      observeIdleMs: 1,
      observeTimeoutMs: 200,
      outputDir: await createTempOutputDir(),
      runtime: {
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

    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "send",
        providerId: "telegram",
        text: "DM baseline marker check.",
      }),
    );
    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({
        fixture: expect.objectContaining({
          target: {
            id: "dm:alice",
            metadata: {},
          },
        }),
      }),
    );
    expect(provider.waitForInbound).not.toHaveBeenCalled();
    expect(transport.state.getSnapshot().messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "outbound",
          text: expect.stringContaining("[telegram mock]"),
        }),
      ]),
    );
    await transport.cleanup?.();
    expect(provider.cleanup).toHaveBeenCalled();
  });

  it("executes generic message actions against the Crabline-backed bus", async () => {
    const transport = await createQaCrablineTransportAdapter({
      outputDir: await createTempOutputDir(),
      selection: createSelection(),
      state: createQaBusState(),
    });
    const outbound = await transport.state.addOutboundMessage({
      text: "mock action target",
      to: "channel:qa-room",
    });

    const threadResult = (await transport.handleAction({
      accountId: null,
      action: "thread-create",
      args: {
        conversationId: "qa-room",
        title: "QA Thread",
      },
      cfg: {},
    })) as { thread?: { id?: string } };
    expect(threadResult.thread?.id).toMatch(/^thread-/u);

    await expect(
      transport.handleAction({
        action: "react",
        args: {
          emoji: "white_check_mark",
          messageId: outbound.id,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({
      message: {
        reactions: [expect.objectContaining({ emoji: "white_check_mark" })],
      },
    });

    await expect(
      transport.handleAction({
        action: "edit",
        args: {
          messageId: outbound.id,
          text: "mock action target edited",
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({
      message: {
        text: "mock action target edited",
      },
    });

    await expect(
      transport.handleAction({
        action: "delete",
        args: {
          messageId: outbound.id,
        },
        cfg: {},
      }),
    ).resolves.toMatchObject({
      message: {
        deleted: true,
      },
    });

    await transport.cleanup?.();
  });
});

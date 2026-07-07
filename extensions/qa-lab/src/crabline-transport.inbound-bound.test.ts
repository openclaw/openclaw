// Qa Lab tests cover Crabline inbound JSON response bounds.
import type {
  CrablineServerManifest,
  OpenClawCrablineChannelDriverSelection,
  StartedOpenClawCrablineAdapter,
} from "@openclaw/crabline";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";

const startOpenClawCrablineAdapterMock = vi.hoisted(() => vi.fn());
const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("@openclaw/crabline", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/crabline")>();
  return {
    ...actual,
    startOpenClawCrablineAdapter: startOpenClawCrablineAdapterMock,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  };
});

let createQaCrablineTransportAdapter: typeof import("./crabline-transport.js").createQaCrablineTransportAdapter;

function createSelection(channel: OpenClawCrablineChannelDriverSelection["channel"] = "telegram") {
  return {
    capabilityMatrixPath: "crabline-fake-provider-capabilities.json",
    channel,
    channelDriver: "crabline",
    smokeArtifactPath: "crabline-fake-provider-smoke.json",
  } as const;
}

function createMockAdapter(channel: string): StartedOpenClawCrablineAdapter {
  const manifest: CrablineServerManifest = {
    provider: channel,
    adminToken: "test-admin-token",
    endpoints: {
      adminInboundUrl: "http://127.0.0.1:9999/admin/inbound",
      apiRoot: "http://127.0.0.1:9999",
    },
  } as unknown as CrablineServerManifest;
  return {
    accountId: "default",
    channel,
    close: vi.fn().mockResolvedValue(undefined),
    createAgentDelivery: ({ target }) => ({
      channel,
      replyChannel: channel,
      replyTo: target,
      to: target,
    }),
    createChannelDriverSmokeEnv: (env) => env,
    createGatewayConfig: () => ({ channels: { [channel]: { enabled: true } } }),
    createInbound: ({ input }) => ({
      providerBody: {
        update_id: 1,
        message: {
          chat: {
            id: input.conversation.id,
            type: input.conversation.kind === "group" ? "supergroup" : "private",
          },
          from: { id: Number(input.senderId), first_name: input.senderName ?? "QA" },
          message_id: 1,
          text: input.text,
        },
      },
      providerHeaders: { "content-type": "application/json" },
      providerTargetKey: input.conversation.id,
      providerUrl: manifest.endpoints.adminInboundUrl,
      qaTarget: input.conversation.id,
      stateConversation: {
        id: input.conversation.id,
        kind: input.conversation.kind as "direct" | "group",
      },
    }),
    createOutboundFromRecorderEvent: () => null,
    manifest,
    probe: vi.fn().mockResolvedValue({}),
    requiredPluginIds: [channel],
  } as unknown as StartedOpenClawCrablineAdapter;
}

function jsonResponse(body: unknown) {
  return {
    response: new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

function oversizedJsonResponse() {
  const chunk = Buffer.alloc(1024 * 1024, "x");
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 17; i++) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
  return {
    response: new Response(stream, {
      headers: { "content-type": "application/json" },
      status: 200,
    }),
    release: vi.fn().mockResolvedValue(undefined),
  };
}

describe("postCrablineInbound JSON response bounds", () => {
  beforeAll(async () => {
    ({ createQaCrablineTransportAdapter } = await import("./crabline-transport.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("parses a normal JSON inbound response", async () => {
    await withTempDir("qa-crabline-inbound-bound-", async (outputDir) => {
      const adapter = createMockAdapter("telegram");
      startOpenClawCrablineAdapterMock.mockResolvedValueOnce(adapter);
      fetchWithSsrFGuardMock.mockResolvedValueOnce(jsonResponse({ update_id: 42 }));

      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        const message = await transport.sendInbound({
          conversation: { id: "alice", kind: "direct" },
          senderId: "100001",
          senderName: "Alice",
          text: "hello",
        });

        expect(message.text).toBe("hello");
        expect(fetchWithSsrFGuardMock).toHaveBeenCalledTimes(1);
        const call = fetchWithSsrFGuardMock.mock.calls[0];
        expect(call?.[0].url).toBe(adapter.manifest.endpoints.adminInboundUrl);
      } finally {
        await transport.cleanup?.();
      }
    });
  });

  it("rejects an oversized JSON inbound response", async () => {
    await withTempDir("qa-crabline-inbound-bound-", async (outputDir) => {
      const adapter = createMockAdapter("telegram");
      startOpenClawCrablineAdapterMock.mockResolvedValueOnce(adapter);
      fetchWithSsrFGuardMock.mockResolvedValueOnce(oversizedJsonResponse());

      const transport = await createQaCrablineTransportAdapter({
        outputDir,
        selection: createSelection(),
        state: createQaBusState(),
      });

      try {
        await expect(
          transport.sendInbound({
            conversation: { id: "alice", kind: "direct" },
            senderId: "100001",
            senderName: "Alice",
            text: "hello",
          }),
        ).rejects.toThrow(/qa-lab-crabline-telegram-inbound: JSON response exceeds/);
      } finally {
        await transport.cleanup?.();
      }
    });
  });
});

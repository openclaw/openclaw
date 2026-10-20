// Qa Lab tests cover bounded Crabline provider responses and failed-body cleanup.
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { createQaCrablineTransportAdapter } from "./crabline-transport.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const inbound = {
  conversation: { id: "-1001234567890", kind: "group" },
  senderId: "100001",
  senderName: "Alice",
  text: "Telegram response marker.",
} as const;

async function withTransport(
  run: (transport: Awaited<ReturnType<typeof createQaCrablineTransportAdapter>>) => Promise<void>,
) {
  await withTempDir("qa-crabline-transport-", async (outputDir) => {
    const transport = await createQaCrablineTransportAdapter({
      outputDir,
      selection: {
        capabilityMatrixPath: "crabline-channel-driver-capabilities.json",
        channel: "telegram",
        channelDriver: "crabline",
        providerReadinessArtifactPath: "crabline-provider-readiness.json",
      },
      state: createQaBusState(),
    });
    try {
      await run(transport);
    } finally {
      await transport.cleanupAfterGatewayStop();
    }
  });
}

describe("crabline transport responses", () => {
  it("rejects oversized successful inbound responses before parsing provider metadata", async () => {
    await withTransport(async (transport) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                update: { message: { message_id: 42, padding: "x".repeat(1024 * 1024) } },
              }),
            ),
        ),
      );

      await expect(transport.sendInbound(inbound)).rejects.toThrow(
        "JSON response exceeds 1048576 bytes",
      );
    });
  });

  it("cancels a failed inbound response before surfacing the provider error", async () => {
    await withTransport(async (transport) => {
      const cancel = vi.fn(() => {
        throw new Error("cancel failed");
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(new ReadableStream<Uint8Array>({ cancel }), {
              status: 503,
            }),
        ),
      );

      await expect(transport.sendInbound(inbound)).rejects.toThrow(
        "Crabline telegram inbound injection failed with HTTP 503",
      );
      expect(cancel).toHaveBeenCalledOnce();
    });
  });
});

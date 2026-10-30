// Qa Lab tests cover bounded Crabline provider responses and failed-body cleanup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTransport } from "./crabline-transport.test-support.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const inbound = {
  conversation: { id: "-1001234567890", kind: "group" },
  senderId: "100001",
  senderName: "Alice",
  text: "Telegram response marker.",
} as const;

describe("crabline transport responses", () => {
  it("rejects oversized successful inbound responses before parsing provider metadata", async () => {
    await withTransport("telegram", async (transport) => {
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
    await withTransport("telegram", async (transport) => {
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

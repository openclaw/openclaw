import { describe, expect, it, vi } from "vitest";

vi.mock("node:dgram", async () => {
  const { EventEmitter } = await import("node:events");
  class FakeSocket extends EventEmitter {
    private port = 0;
    bind(port: number) {
      this.port = port || 5555;
      queueMicrotask(() => this.emit("listening"));
    }
    address() {
      return { port: this.port || 5555 } as any;
    }
    close() {}
  }
  return {
    default: {
      createSocket: () => new FakeSocket(),
    },
  };
});

import { AriMedia } from "./ari-media.js";

const cfg = {
  baseUrl: "http://127.0.0.1:8088",
  username: "user",
  password: "pass",
  app: "openclaw",
  rtpHost: "127.0.0.1",
  rtpPort: 12000,
  codec: "ulaw",
} as const;

describe("AriMedia", () => {
  it("retries addChannelsToBridge on error", async () => {
    const client = {
      createBridge: vi
        .fn()
        .mockResolvedValueOnce({ id: "bridge-1" })
        .mockResolvedValueOnce({ id: "bridge-2" }),
      createExternalMedia: vi
        .fn()
        .mockResolvedValueOnce({ id: "ext-1" })
        .mockResolvedValueOnce({ id: "stt-ext-1" }),
      addChannelsToBridge: vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce(undefined),
      getBridge: vi.fn().mockResolvedValue({ id: "bridge-1", channels: ["sip-1", "ext-1"] }),
      createSnoop: vi.fn().mockResolvedValue({ id: "snoop-1" }),
      addChannelToBridge: vi.fn().mockResolvedValue(undefined),
      deleteBridge: vi.fn().mockResolvedValue(undefined),
      safeHangupChannel: vi.fn().mockResolvedValue(undefined),
    } as any;

    const media = new AriMedia(cfg, client);
    const graph = await media.createMediaGraph({ sipChannelId: "sip-1" });

    expect(client.addChannelsToBridge).toHaveBeenCalledTimes(2);
    expect(graph.extChannelId).toBe("ext-1");
    expect(graph.sttExtChannelId).toBe("stt-ext-1");
    expect(graph.snoopChannelId).toBe("snoop-1");

    await media.teardown(graph);
    expect(client.safeHangupChannel).toHaveBeenCalledTimes(3);
    expect(client.deleteBridge).toHaveBeenCalledTimes(2);
  });
});

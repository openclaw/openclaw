import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMattermostConnectOnce } from "./monitor-websocket.js";

const captureHost = vi.hoisted(() => ({
  capture: vi.fn<typeof import("openclaw/plugin-sdk/proxy-capture").captureWsEventAsync>(),
}));

vi.mock("openclaw/plugin-sdk/proxy-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/proxy-capture")>()),
  captureWsEventAsync: captureHost.capture,
}));

describe("Mattermost websocket capture", () => {
  beforeEach(() => {
    captureHost.capture.mockReset().mockResolvedValue(undefined);
  });

  it.each(["present", "rejected"] as const)(
    "authenticates and delivers posts with %s async capture",
    async (capability) => {
      if (capability === "rejected") {
        captureHost.capture.mockRejectedValue(new Error("capture write failed"));
      }
      const socket = Object.assign(new EventEmitter(), {
        send: vi.fn(),
        ping: vi.fn(),
        close: vi.fn(),
        terminate: vi.fn(),
      });
      const onPosted = vi.fn(async () => {});
      const statusSink = vi.fn();
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      const connected = createMattermostConnectOnce({
        wsUrl: "wss://mattermost.example/api/v4/websocket",
        botToken: "test-token",
        nextSeq: () => 7,
        onPosted,
        statusSink,
        runtime,
        webSocketFactory: () => socket,
      })();
      const posted = JSON.stringify({ event: "posted", data: { post: '{"id":"post-1"}' } });
      try {
        socket.emit("open");
        expect(socket.send).toHaveBeenCalledWith(
          JSON.stringify({
            seq: 7,
            action: "authentication_challenge",
            data: { token: "test-token" },
          }),
        );
        socket.emit("message", Buffer.from('{"status":"OK","seq_reply":7}'));
        expect(statusSink).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "ready" }));
        socket.emit("message", Buffer.from(posted));
        expect(onPosted).toHaveBeenCalledWith(posted);
        socket.emit("error", new Error("socket failure"));
        expect(socket.close).toHaveBeenCalledOnce();
        expect(runtime.error).toHaveBeenCalledWith(
          "mattermost websocket error: Error: socket failure",
        );
      } finally {
        socket.emit("close", 1000, Buffer.alloc(0));
        await connected;
      }
      expect(captureHost.capture.mock.calls.map(([event]) => event.kind)).toEqual([
        "ws-open",
        "ws-frame",
        "ws-frame",
        "ws-frame",
        "error",
        "ws-close",
      ]);
      expect(captureHost.capture).toHaveBeenCalledWith(
        expect.objectContaining({
          url: "wss://mattermost.example/api/v4/websocket",
          direction: "inbound",
          payload: Buffer.from(posted),
          meta: { subsystem: "mattermost-websocket" },
        }),
      );
    },
  );
});

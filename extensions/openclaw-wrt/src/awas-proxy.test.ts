import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { AwasDeviceProxy } from "./awas-proxy.js";

function createLogger() {
  return {
    info() {},
    warn: vi.fn(),
    error() {},
    debug: vi.fn(),
  };
}

describe("AwasDeviceProxy", () => {
  it("caps queued messages while AWAS is disconnected", () => {
    const logger = createLogger();
    const proxy = new AwasDeviceProxy({
      deviceId: "dev-1",
      config: {
        enabled: true,
        host: "127.0.0.1",
        port: 8080,
        path: "/ws/clawwrt",
        ssl: false,
      },
      logger,
      onCommand() {},
    });

    for (let i = 0; i < 140; i += 1) {
      proxy.forwardToAwas({ op: "heartbeat", seq: i });
    }

    const queued = (proxy as unknown as { messageQueue: Array<Record<string, unknown>> })
      .messageQueue;
    expect(queued).toHaveLength(128);
    expect(queued[0]?.seq).toBe(12);
    expect(queued.at(-1)?.seq).toBe(139);
    expect(logger.warn).toHaveBeenCalledTimes(12);
  });

  it("requeues payloads when the AWAS send callback fails", () => {
    const logger = createLogger();
    const proxy = new AwasDeviceProxy({
      deviceId: "dev-1",
      config: {
        enabled: true,
        host: "127.0.0.1",
        port: 8080,
        path: "/ws/clawwrt",
        ssl: false,
      },
      logger,
      onCommand() {},
    });

    (
      proxy as unknown as {
        ws: {
          readyState: number;
          send: (text: string, cb?: (error?: Error) => void) => void;
        };
      }
    ).ws = {
      readyState: WebSocket.OPEN,
      send(_text: string, cb?: (error?: Error) => void) {
        cb?.(new Error("socket closed during send"));
      },
    };

    proxy.forwardToAwas({ op: "heartbeat", seq: 1 });

    const queued = (proxy as unknown as { messageQueue: Array<Record<string, unknown>> })
      .messageQueue;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ op: "heartbeat", seq: 1, device_id: "dev-1" });
  });

  it("requeues payloads when AWAS send throws synchronously", () => {
    const logger = createLogger();
    const proxy = new AwasDeviceProxy({
      deviceId: "dev-1",
      config: {
        enabled: true,
        host: "127.0.0.1",
        port: 8080,
        path: "/ws/clawwrt",
        ssl: false,
      },
      logger,
      onCommand() {},
    });

    (
      proxy as unknown as {
        ws: {
          readyState: number;
          send: (_text: string, _cb?: (error?: Error) => void) => void;
        };
      }
    ).ws = {
      readyState: WebSocket.OPEN,
      send() {
        throw new Error("socket transitioned to closing");
      },
    };

    proxy.forwardToAwas({ op: "heartbeat", seq: 2 });

    const queued = (proxy as unknown as { messageQueue: Array<Record<string, unknown>> })
      .messageQueue;
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ op: "heartbeat", seq: 2, device_id: "dev-1" });
  });

  it("redacts sensitive fields in AWAS send debug logs", () => {
    const logger = createLogger();
    const proxy = new AwasDeviceProxy({
      deviceId: "dev-1",
      config: {
        enabled: true,
        host: "127.0.0.1",
        port: 8080,
        path: "/ws/clawwrt",
        ssl: false,
      },
      logger,
      onCommand() {},
    });

    (
      proxy as unknown as {
        ws: {
          readyState: number;
          send: (text: string, cb?: (error?: Error) => void) => void;
        };
      }
    ).ws = {
      readyState: WebSocket.OPEN,
      send(_text: string, cb?: (error?: Error) => void) {
        cb?.();
      },
    };

    proxy.forwardToAwas({
      op: "connect",
      token: "secret-token",
      command: "sensitive-command",
    });

    const debugLog = logger.debug.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.includes("sendToAwas full payload for device=dev-1"));

    expect(debugLog).toBeTruthy();
    expect(debugLog).toContain('"token":"[REDACTED]"');
    expect(debugLog).toContain('"command":"[REDACTED]"');
    expect(debugLog).not.toContain("secret-token");
    expect(debugLog).not.toContain("sensitive-command");
  });

  it("ignores legacy AWAS response frames and does not forward them as commands", () => {
    const onCommand = vi.fn();
    const logger = createLogger();
    const proxy = new AwasDeviceProxy({
      deviceId: "dev-response",
      config: {
        enabled: true,
        host: "127.0.0.1",
        port: 8080,
        path: "/ws/clawwrt",
        ssl: false,
      },
      logger,
      onCommand,
    });

    const internals = proxy as unknown as {
      handleAwasMessage: (rawData: unknown) => void;
    };

    // Simulate receiving legacy response frames from AWAS
    internals.handleAwasMessage(
      JSON.stringify({ op: "auth_response", req_id: "req-1", status: "ok" }),
    );
    internals.handleAwasMessage(
      JSON.stringify({ op: "heartbeat_response", req_id: "req-2", timestamp: 12345 }),
    );
    internals.handleAwasMessage(
      JSON.stringify({ op: "get_clients_response", req_id: "req-3", clients: [] }),
    );

    // Verify that onCommand was NOT called for any response frames
    expect(onCommand).not.toHaveBeenCalled();

    // Now send a legitimate command and verify it IS forwarded
    internals.handleAwasMessage(
      JSON.stringify({ op: "auth", req_id: "req-4", client_mac: "AA:BB:CC:DD:EE:FF" }),
    );

    // Verify onCommand was called for the actual command
    expect(onCommand).toHaveBeenCalledOnce();
    expect(onCommand).toHaveBeenCalledWith("dev-response", {
      op: "auth",
      req_id: "req-4",
      client_mac: "AA:BB:CC:DD:EE:FF",
    });
  });
});

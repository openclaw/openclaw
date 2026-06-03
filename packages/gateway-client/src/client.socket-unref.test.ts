/**
 * Regression test for issue #88230.
 *
 * The CLI path `openclaw message send` calls `client.stop()` after delivery
 * and relies on a natural process exit. If the WebSocket's underlying
 * `_socket` file descriptor stays ref'd in the Node event loop, the process
 * hangs indefinitely even though the close handshake has been initiated.
 *
 * `beginStop()` must call `_socket.unref()` immediately after `ws.close()`
 * so the open socket cannot block a natural exit. This test pins that
 * behavior.
 */

import { describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { GatewayClient } from "./client.js";

describe("GatewayClient socket unref (issue #88230)", () => {
  test("unrefs the underlying socket on stop() so the event loop can drain", () => {
    const client = new GatewayClient({ requestTimeoutMs: 1000 });

    const unref = vi.fn();
    const close = vi.fn();

    // Inject a minimal fake ws with the internal `_socket.unref()` the
    // `ws` package exposes. This matches the technique used by the existing
    // `closes on missing ticks` watchdog tests in this package.
    (
      client as unknown as {
        ws: {
          readyState: number;
          send: () => void;
          close: () => void;
          _socket: { unref: () => void };
        };
      }
    ).ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close,
      _socket: { unref },
    };

    expect(unref).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();

    client.stop();

    expect(close).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);
  });

  test("tolerates a ws without an internal _socket (defensive contract)", () => {
    // `_socket` is an internal property of the `ws` package with no public
    // contract; the production code wraps the unref in try/catch. Verify
    // stop() does not throw when _socket is absent.
    const client = new GatewayClient({ requestTimeoutMs: 1000 });

    const close = vi.fn();

    (
      client as unknown as {
        ws: { readyState: number; send: () => void; close: () => void };
      }
    ).ws = {
      readyState: WebSocket.OPEN,
      send: vi.fn(),
      close,
    };

    expect(() => client.stop()).not.toThrow();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

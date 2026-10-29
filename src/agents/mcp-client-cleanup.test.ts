import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import * as logger from "../logger.js";
import { disposeMcpClient } from "./mcp-client-lifecycle.js";

afterEach(() => vi.restoreAllMocks());

describe("MCP local cleanup authority", () => {
  it("does not report remote DELETE rejection to local cleanup observers", async () => {
    vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    const onCleanupError = vi.fn();
    const transport = {
      start: async () => {},
      send: async () => {},
      close: vi.fn(async () => {}),
      terminateSession: async () => {
        throw new Error("remote refused");
      },
    };
    const client = { close: vi.fn(async () => {}) };
    await expect(
      disposeMcpClient({ transport, client, transportType: "streamable-http", onCleanupError }),
    ).resolves.toBe("closed");
    expect(transport.close).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(onCleanupError).not.toHaveBeenCalled();
  });
  it.each(["transport", "client"])(
    "keeps failed %s close uncertain despite remote DELETE failure",
    async (owner) => {
      vi.spyOn(logger, "logWarn").mockImplementation(() => {});
      const failure = new Error("local still owned");
      const onCleanupError = vi.fn();
      const transport = {
        start: async () => {},
        send: async () => {},
        close: vi.fn(async () => {
          if (owner === "transport") {
            throw failure;
          }
        }),
        terminateSession: async () => {
          throw new Error("remote refused");
        },
      };
      const client = {
        close: vi.fn(async () => {
          if (owner === "client") {
            throw failure;
          }
        }),
      };
      await expect(
        disposeMcpClient({ transport, client, transportType: "streamable-http", onCleanupError }),
      ).resolves.toBe("uncertain");
      expect(onCleanupError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(client.close).toHaveBeenCalledOnce();
    },
  );
  it("keeps hung local closure uncertain and detaches diagnostics only after bounded cleanup", async () => {
    vi.useFakeTimers();
    try {
      const held = createDeferred();
      const detachStderr = vi.fn();
      const transport = {
        start: async () => {},
        send: async () => {},
        close: async () => held.promise,
        terminateSession: async () => {},
      };
      const closing = disposeMcpClient(
        {
          transport,
          client: { close: async () => {} },
          transportType: "streamable-http",
          detachStderr,
        },
        20,
      );
      expect(detachStderr).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(40);
      await expect(closing).resolves.toBe("uncertain");
      expect(detachStderr).toHaveBeenCalledOnce();
      held.resolve();
    } finally {
      vi.useRealTimers();
    }
  });
});

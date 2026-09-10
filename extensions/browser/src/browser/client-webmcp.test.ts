import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserWebMcp } from "./client-webmcp.js";

const dispatch = vi.hoisted(() => vi.fn());
vi.mock("./local-dispatch.runtime.js", () => ({ dispatchBrowserControlRequest: dispatch }));

const request = {
  targetId: "tab",
  contextId: "document",
  toolName: "increment_counter",
  input: {},
};

afterEach(() => {
  vi.restoreAllMocks();
  dispatch.mockReset();
});

describe("WebMCP execution transport uncertainty", () => {
  it.each(["timeout", "cancel"])(
    "does not invite a retry after local dispatch %s",
    async (failure) => {
      let counter = 0;
      let finish: ((value: { status: number; body: unknown }) => void) | undefined;
      const controller = new AbortController();
      dispatch.mockImplementation(() => {
        counter++;
        if (failure === "cancel") {
          controller.abort();
        }
        return new Promise((resolve) => {
          finish = resolve;
        });
      });
      try {
        await expect(
          browserWebMcp(undefined, "execute", request, {
            timeoutMs: 25,
            signal: controller.signal,
          }),
        ).rejects.toMatchObject({
          message: "WebMCP execution outcome unknown. Inspect the page before retrying.",
        });
        expect(counter).toBe(1);
        expect(dispatch).toHaveBeenCalledTimes(1);
      } finally {
        finish?.({ status: 200, body: { result: counter } });
      }
    },
  );

  it.each(["disconnect", "error-response"])(
    "does not invite a retry after an HTTP %s",
    async (failure) => {
      let counter = 0;
      const server = createServer((_req, res) => {
        counter++;
        if (failure === "disconnect") {
          res.destroy();
        } else {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "timed out" }));
        }
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected TCP listener");
      }
      try {
        await expect(
          browserWebMcp(`http://127.0.0.1:${address.port}`, "execute", request),
        ).rejects.toMatchObject({
          message: "WebMCP execution outcome unknown. Inspect the page before retrying.",
        });
        expect(counter).toBe(1);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it("retains discovery errors and successful execution results", async () => {
    dispatch.mockRejectedValueOnce(new Error("connection reset"));
    await expect(browserWebMcp(undefined, "list", { targetId: "tab" })).rejects.toThrow(
      "Retry the browser tool once",
    );
    dispatch.mockResolvedValueOnce({ status: 200, body: { result: { counter: 1 } } });
    await expect(browserWebMcp(undefined, "execute", request)).resolves.toEqual({
      result: { counter: 1 },
    });
  });
});

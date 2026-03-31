import type { PluginLogger } from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";
import { DatabricksSqlClient } from "./client.js";

function createLogger(): PluginLogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe("databricks sql client", () => {
  it("sends auth header and statement payload", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer dapi-test");
      expect(headers.get("Content-Type")).toBe("application/json");
      const body = JSON.parse(String(init?.body));
      expect(body.statement).toBe("SELECT 1");
      expect(body.warehouse_id).toBe("wh-1");
      return new Response(
        JSON.stringify({ statement_id: "stmt-1", status: { state: "SUCCEEDED" } }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    const client = new DatabricksSqlClient({
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 10_000,
        retryCount: 0,
        readOnly: true,
      },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    const result = await client.executeStatement({
      statement: "SELECT 1",
      warehouseId: "wh-1",
    });
    expect(result).toEqual({ statement_id: "stmt-1", status: { state: "SUCCEEDED" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries transient http failures", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "try again" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ statement_id: "stmt-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const client = new DatabricksSqlClient({
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 10_000,
        retryCount: 1,
        readOnly: true,
      },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    const result = await client.executeStatement({
      statement: "SELECT 1",
      warehouseId: "wh-1",
    });
    expect(result).toEqual({ statement_id: "stmt-2" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("raises timeout error when request aborts", async () => {
    const fetchImpl = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });

    const client = new DatabricksSqlClient({
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 20,
        retryCount: 0,
        readOnly: true,
      },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    await expect(
      client.executeStatement({
        statement: "SELECT 1",
        warehouseId: "wh-1",
      }),
    ).rejects.toMatchObject({
      code: "TIMEOUT",
    });
  });
});

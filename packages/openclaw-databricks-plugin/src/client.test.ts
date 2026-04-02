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

function createBaseConfig() {
  return {
    host: "https://dbc-example.cloud.databricks.com",
    token: "dapi-test",
    warehouseId: "wh-1",
    timeoutMs: 10_000,
    retryCount: 1,
    pollingIntervalMs: 1,
    maxPollingWaitMs: 5_000,
    allowedCatalogs: [],
    allowedSchemas: [],
    readOnly: true as const,
  };
}

describe("databricks sql client", () => {
  it("sends auth header and statement payload", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer dapi-test");
      expect(headers.get("Content-Type")).toBe("application/json");
      const rawBody = init?.body;
      const body = JSON.parse(typeof rawBody === "string" ? rawBody : "{}");
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
      config: { ...createBaseConfig(), retryCount: 0 },
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

  it("retries transient submit failures using retryCount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "try again" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ statement_id: "stmt-2", status: { state: "SUCCEEDED" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    const client = new DatabricksSqlClient({
      config: { ...createBaseConfig(), retryCount: 1 },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    const result = await client.executeStatement({
      statement: "SELECT 1",
      warehouseId: "wh-1",
    });
    expect(result).toEqual({ statement_id: "stmt-2", status: { state: "SUCCEEDED" } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("raises timeout error when submit request aborts", async () => {
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
      config: { ...createBaseConfig(), timeoutMs: 20, retryCount: 0 },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    await expect(
      client.executeStatement({
        statement: "SELECT 1",
        warehouseId: "wh-1",
      }),
    ).rejects.toMatchObject({
      code: "STATEMENT_TIMEOUT",
    });
  });

  it("polls until statement reaches terminal success status", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-3",
            status: { state: "PENDING" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-3",
            status: { state: "RUNNING" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-3",
            status: { state: "SUCCEEDED" },
            result: { data_array: [[1]] },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new DatabricksSqlClient({
      config: { ...createBaseConfig(), retryCount: 0 },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    const result = await client.executeStatement({
      statement: "SELECT 1",
      warehouseId: "wh-1",
    });
    expect(result).toEqual({
      statement_id: "stmt-3",
      status: { state: "SUCCEEDED" },
      result: { data_array: [[1]] },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("fails when statement reaches terminal failed status", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          statement_id: "stmt-failed",
          status: { state: "FAILED", error_message: "permission denied" },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const client = new DatabricksSqlClient({
      config: { ...createBaseConfig(), retryCount: 0 },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    await expect(
      client.executeStatement({
        statement: "SELECT * FROM secret.table",
        warehouseId: "wh-1",
      }),
    ).rejects.toMatchObject({
      code: "STATEMENT_FAILED",
      message: "permission denied",
    });
  });

  it("fails when statement remains pending past max wait", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-4",
            status: { state: "PENDING" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockImplementation(async () => {
        return new Response(
          JSON.stringify({
            statement_id: "stmt-4",
            status: { state: "RUNNING" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      });

    const client = new DatabricksSqlClient({
      config: { ...createBaseConfig(), retryCount: 0, maxPollingWaitMs: 1 },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    await expect(
      client.executeStatement({
        statement: "SELECT 1",
        warehouseId: "wh-1",
      }),
    ).rejects.toMatchObject({
      code: "STATEMENT_PENDING_MAX_WAIT",
    });
  });

  it("retries transient polling errors using retryCount", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-5",
            status: { state: "PENDING" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-5",
            status: { state: "SUCCEEDED" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new DatabricksSqlClient({
      config: { ...createBaseConfig(), retryCount: 1 },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    const result = await client.executeStatement({
      statement: "SELECT 1",
      warehouseId: "wh-1",
    });
    expect(result).toEqual({
      statement_id: "stmt-5",
      status: { state: "SUCCEEDED" },
    });
  });
});

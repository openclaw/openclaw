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
        pollingIntervalMs: 1_000,
        maxPollingWaitMs: 30_000,
        allowedCatalogs: [],
        allowedSchemas: [],
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
        pollingIntervalMs: 1_000,
        maxPollingWaitMs: 30_000,
        allowedCatalogs: [],
        allowedSchemas: [],
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
        pollingIntervalMs: 1_000,
        maxPollingWaitMs: 30_000,
        allowedCatalogs: [],
        allowedSchemas: [],
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
      code: "STATEMENT_TIMEOUT",
    });
  });

  it("polls until statement reaches terminal status", async () => {
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
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 10_000,
        retryCount: 0,
        pollingIntervalMs: 1,
        maxPollingWaitMs: 5_000,
        allowedCatalogs: [],
        allowedSchemas: [],
        readOnly: true,
      },
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

  it("fails when statement remains pending past max wait", async () => {
    const fetchImpl = vi.fn();
    fetchImpl.mockResolvedValueOnce(
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
    );
    fetchImpl.mockImplementation(async () => {
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
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 10_000,
        retryCount: 0,
        pollingIntervalMs: 1,
        maxPollingWaitMs: 1,
        allowedCatalogs: [],
        allowedSchemas: [],
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
      code: "STATEMENT_PENDING_MAX_WAIT",
    });
  });

  it("recovers from transient 429 during polling", async () => {
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
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 10_000,
        retryCount: 0,
        pollingIntervalMs: 1,
        maxPollingWaitMs: 5_000,
        allowedCatalogs: [],
        allowedSchemas: [],
        readOnly: true,
      },
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

  it("recovers from transient 5xx during polling", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-6",
            status: { state: "RUNNING" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "temporary backend error" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-6",
            status: { state: "SUCCEEDED" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );

    const client = new DatabricksSqlClient({
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 10_000,
        retryCount: 0,
        pollingIntervalMs: 1,
        maxPollingWaitMs: 5_000,
        allowedCatalogs: [],
        allowedSchemas: [],
        readOnly: true,
      },
      logger: createLogger(),
      deps: { fetchImpl, sleep: async () => {} },
    });

    const result = await client.executeStatement({
      statement: "SELECT 1",
      warehouseId: "wh-1",
    });
    expect(result).toEqual({
      statement_id: "stmt-6",
      status: { state: "SUCCEEDED" },
    });
  });

  it("fails with pending-max-wait when statement never reaches terminal state", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-7",
            status: { state: "RUNNING" },
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
            statement_id: "stmt-7",
            status: { state: "RUNNING" },
          }),
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
        pollingIntervalMs: 500,
        maxPollingWaitMs: 300,
        allowedCatalogs: [],
        allowedSchemas: [],
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
      code: "STATEMENT_PENDING_MAX_WAIT",
    });
  });

  it("fails with polling-timeout when transient polling errors consume budget", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-7b",
            status: { state: "RUNNING" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockImplementation(async () => {
        return new Response(JSON.stringify({ message: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      });

    const client = new DatabricksSqlClient({
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 10_000,
        retryCount: 0,
        pollingIntervalMs: 500,
        maxPollingWaitMs: 300,
        allowedCatalogs: [],
        allowedSchemas: [],
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
      code: "POLLING_TIMEOUT",
    });
  });

  it("fails with polling timeout when transient polling timeouts consume budget", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            statement_id: "stmt-8",
            status: { state: "PENDING" },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockImplementation(async () => {
        throw new DOMException("aborted", "AbortError");
      });

    const client = new DatabricksSqlClient({
      config: {
        host: "https://dbc-example.cloud.databricks.com",
        token: "dapi-test",
        warehouseId: "wh-1",
        timeoutMs: 1_000,
        retryCount: 0,
        pollingIntervalMs: 500,
        maxPollingWaitMs: 300,
        allowedCatalogs: [],
        allowedSchemas: [],
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
      code: "POLLING_TIMEOUT",
    });
  });
});

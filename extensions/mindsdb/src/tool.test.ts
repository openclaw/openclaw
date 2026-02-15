import { afterEach, describe, expect, it, vi } from "vitest";
import { createMindsdbTool, looksMutatingQuery, resolveMindsdbPluginConfig } from "./tool.js";

const originalFetch = globalThis.fetch;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function fakeApi(pluginConfig: Record<string, unknown>) {
  return {
    id: "mindsdb",
    name: "MindsDB",
    source: "test",
    config: {},
    pluginConfig,
    runtime: {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    registerTool() {},
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath: (input: string) => input,
    on() {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe("mindsdb tool", () => {
  it("runs query action with bearer token and row preview truncation", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        type: "table",
        column_names: ["id"],
        data: [[1], [2], [3]],
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const tool = createMindsdbTool(
      fakeApi({ token: "token-123" }) as never,
      resolveMindsdbPluginConfig({ token: "token-123", maxRows: 2, maxChars: 10_000 }),
    );

    const result = (await tool.execute("call-1", {
      action: "query",
      query: "SELECT * FROM t",
    })) as {
      details: {
        responseType: string;
        totalRows: number;
        shownRows: number;
        outputTruncated: boolean;
      };
      content: Array<{ type: string; text: string }>;
    };

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:47334/api/sql/query");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-123");

    const requestBody = JSON.parse(String(init.body));
    expect(requestBody.query).toBe("SELECT * FROM t");

    expect(result.details.responseType).toBe("table");
    expect(result.details.totalRows).toBe(3);
    expect(result.details.shownRows).toBe(2);
    expect(result.details.outputTruncated).toBe(false);
    expect(result.content[0]?.text).toContain("truncated_rows");
  });

  it("logs in once and reuses cached login token", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ token: "session-token" }))
      .mockResolvedValueOnce(jsonResponse({ type: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ type: "ok" }));
    vi.stubGlobal("fetch", fetchSpy);

    const tool = createMindsdbTool(
      fakeApi({ username: "mindsdb", password: "mindsdb" }) as never,
      resolveMindsdbPluginConfig({ username: "mindsdb", password: "mindsdb" }),
    );

    await tool.execute("call-1", { action: "query", query: "SELECT 1" });
    await tool.execute("call-2", { action: "query", query: "SELECT 2" });

    expect(fetchSpy).toHaveBeenCalledTimes(3);

    const [loginUrl] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(loginUrl).toBe("http://127.0.0.1:47334/api/login");

    const [, firstQueryInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect((firstQueryInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer session-token",
    );

    const [, secondQueryInit] = fetchSpy.mock.calls[2] as [string, RequestInit];
    expect((secondQueryInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer session-token",
    );
  });

  it("blocks mutating SQL by default", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const tool = createMindsdbTool(fakeApi({}) as never, resolveMindsdbPluginConfig({}));

    await expect(
      tool.execute("call-1", {
        action: "query",
        query: "CREATE DATABASE analytics WITH ENGINE = 'postgres'",
      }),
    ).rejects.toThrow(/Mutating queries are disabled/i);

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("supports list_databases action", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ type: "table", data: [["mindsdb"]], column_names: ["name"] }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    const tool = createMindsdbTool(
      fakeApi({ token: "abc" }) as never,
      resolveMindsdbPluginConfig({ token: "abc" }),
    );

    await tool.execute("call-1", { action: "list_databases" });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:47334/api/sql/list_databases");
    expect(init.method).toBe("GET");
  });

  it("truncates very large outputs by maxChars", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(
      jsonResponse({
        type: "table",
        column_names: ["payload"],
        data: [["x".repeat(6_000)]],
      }),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const tool = createMindsdbTool(
      fakeApi({ token: "abc" }) as never,
      resolveMindsdbPluginConfig({ token: "abc", maxChars: 1_000 }),
    );

    const result = (await tool.execute("call-1", {
      action: "query",
      query: "SELECT 1",
    })) as {
      details: { outputTruncated: boolean };
      content: Array<{ text: string }>;
    };

    expect(result.details.outputTruncated).toBe(true);
    expect(result.content[0]?.text).toContain("[truncated");
  });
});

describe("mindsdb query classifier", () => {
  it("recognizes read-only and mutating SQL", () => {
    expect(looksMutatingQuery("SELECT * FROM information_schema.databases")).toBe(false);
    expect(looksMutatingQuery("-- comment\nSHOW DATABASES")).toBe(false);
    expect(looksMutatingQuery("CREATE DATABASE demo WITH ENGINE='postgres'")).toBe(true);
  });
});

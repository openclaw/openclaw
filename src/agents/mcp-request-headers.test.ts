import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { isSecretValueRegisteredForRedaction } from "../logging/secret-redaction-registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { OpenClawPluginMcpServerRequestHeaderProvider } from "../plugins/types.mcp-connection.js";
import { createMcpProofPluginRegistry } from "./mcp-connection-resolver.test-fixtures.js";
import { getMcpRequestContext, runWithMcpRequestContext } from "./mcp-request-context.js";
import { withMcpRequestHeaders } from "./mcp-request-headers.js";

describe("MCP request headers", () => {
  afterEach(() => vi.useRealTimers());

  function fixture(resolve: OpenClawPluginMcpServerRequestHeaderProvider["resolve"]) {
    const proof = createMcpProofPluginRegistry();
    proof
      .apiFor("attribution")
      .registerMcpServerRequestHeaderProvider({ serverName: "probe", resolve });
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    const wrapped = withPluginRuntimeRegistryScope(proof.registry, () =>
      withMcpRequestHeaders({
        serverName: "probe",
        resourceUrl: "https://mcp.example/mcp",
        fetchFn: fetch,
      }),
    );
    return { fetch, wrapped };
  }

  it("copies context, clears missing context, and expires background callbacks", async () => {
    const context = { sessionId: "s", runId: "one", metadata: { token: "original" } };
    let background: Promise<unknown> | undefined;
    const gate = createDeferred();
    const run = runWithMcpRequestContext(context, async () => {
      await Promise.resolve();
      expect(getMcpRequestContext()?.metadata?.token).toBe("original");
      expect(Object.isFrozen(getMcpRequestContext()?.metadata)).toBe(true);
      await runWithMcpRequestContext(undefined, () =>
        expect(getMcpRequestContext()).toBeUndefined(),
      );
      expect(getMcpRequestContext()?.runId).toBe("one");
      background = gate.promise.then(() => getMcpRequestContext());
    });
    context.metadata.token = "mutated";
    await run;
    gate.resolve();
    expect(await background).toBeUndefined();
  });

  it("redacts provider values before fetch and preserves network errors", async () => {
    const { fetch, wrapped } = fixture(() => ({ "x-turn-token": "Bearer synthetic-turn-secret" }));
    const networkError = new Error("network failure");
    fetch.mockImplementation(async () => {
      expect(isSecretValueRegisteredForRedaction("Bearer synthetic-turn-secret")).toBe(true);
      expect(isSecretValueRegisteredForRedaction("synthetic-turn-secret")).toBe(true);
      throw networkError;
    });
    await expect(
      runWithMcpRequestContext({ sessionId: "s", runId: "one" }, () =>
        wrapped("https://mcp.example/mcp"),
      ),
    ).rejects.toBe(networkError);
  });

  it("rejects an operation canceled while headers resolve without dispatching", async () => {
    const resolving = createDeferred();
    const headers = createDeferred<Record<string, string>>();
    const operation = createDeferred();
    const transport = new AbortController();
    const { fetch, wrapped } = fixture(() => {
      resolving.resolve();
      return headers.promise;
    });
    let request: Promise<Response> | undefined;
    const canceled = new Error("Operation canceled");
    const run = runWithMcpRequestContext({ sessionId: "s", runId: "one" }, () => {
      request = wrapped("https://mcp.example/mcp", { signal: transport.signal });
      return operation.promise;
    });
    await resolving.promise;
    const rejectedRun = expect(run).rejects.toBe(canceled);
    operation.reject(canceled);
    await rejectedRun;

    const rejectedRequest = expect(request).rejects.toThrow(/^MCP request context expired$/);
    headers.resolve({ "x-turn": "synthetic-attribution" });
    await rejectedRequest;
    expect(transport.signal.aborted).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dispatches resolved volatile headers while the operation remains active", async () => {
    const { fetch, wrapped } = fixture(async () => ({ "x-turn": "synthetic-attribution" }));
    await runWithMcpRequestContext({ sessionId: "s", runId: "one" }, () =>
      wrapped("https://mcp.example/mcp", { headers: { "x-static": "stable" } }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-turn")).toBe("synthetic-attribution");
    expect(headers.get("x-static")).toBe("stable");
  });

  it("preserves transport abort rejection while headers resolve", async () => {
    const resolving = createDeferred();
    const headers = createDeferred<Record<string, string>>();
    const transport = new AbortController();
    const { fetch, wrapped } = fixture(() => {
      resolving.resolve();
      return headers.promise;
    });
    const aborted = new Error("Transport aborted");
    const request = runWithMcpRequestContext({ sessionId: "s", runId: "one" }, () =>
      wrapped("https://mcp.example/mcp", { signal: transport.signal }),
    );
    await resolving.promise;
    const rejected = expect(request).rejects.toBe(aborted);
    transport.abort(aborted);
    headers.resolve({ "x-turn": "synthetic-attribution" });
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds stalled providers and hides provider exceptions", async () => {
    vi.useFakeTimers();
    const { fetch, wrapped } = fixture(() => new Promise(() => {}));
    const pending = expect(
      runWithMcpRequestContext({ sessionId: "s", runId: "one" }, () =>
        wrapped("https://mcp.example/mcp"),
      ),
    ).rejects.toThrow("MCP request header provider failed");
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(fetch).not.toHaveBeenCalled();
    const throwing = fixture(() => {
      throw new Error("private-provider-secret");
    });
    await expect(
      runWithMcpRequestContext({ sessionId: "s", runId: "one" }, () =>
        throwing.wrapped("https://mcp.example/mcp"),
      ),
    ).rejects.toThrow(/^MCP request header provider failed$/);
  });
});

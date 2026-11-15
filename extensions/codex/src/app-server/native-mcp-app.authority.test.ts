import { afterEach, expect, it, vi } from "vitest";
import { createNativeMcpRuntime } from "./native-mcp-app.js";
import { CodexAppServerScopedRequestRejectedError } from "./rpc-error.js";
import { createClientHarness } from "./test-support.js";

const clients: ReturnType<typeof createClientHarness>["client"][] = [];
const responses = {
  tool: { method: "mcpServer/tool/call", result: { content: [] } },
  catalog: { method: "mcpServerStatus/list", result: { data: [] } },
  resource: { method: "mcpServer/resource/read", result: { contents: [] } },
};
afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// Exercise the actual adapter and client's final transport writes, not a mock
// request implementation that assumes the adapter forwards its authority.
it.each([
  { operation: "tool", revoke: "none" },
  { operation: "tool", revoke: "owner" },
  { operation: "tool", revoke: "grant" },
  { operation: "catalog", revoke: "none" },
  { operation: "catalog", revoke: "owner" },
  { operation: "resource", revoke: "none" },
  { operation: "resource", revoke: "owner" },
] as const)(
  "guards native $operation retry writes when revoking $revoke during overload backoff",
  async ({ operation, revoke }) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const harness = createClientHarness();
    clients.push(harness.client);
    const revocationError = new Error(`App ${revoke} revoked`);
    const authority = { owner: true, grant: true };
    const guard = (kind: keyof typeof authority) => () => {
      if (!authority[kind]) {
        throw revocationError;
      }
    };
    const runtime = createNativeMcpRuntime({
      client: harness.client,
      threadId: "app-thread",
      originCallId: "app-origin",
      attempt: { sessionId: "app-session", workspaceDir: "/workspace" },
      assertCurrent: guard("owner"),
    });
    if (!runtime.readResource) {
      throw new Error("Native MCP resource reads are unavailable");
    }
    const request =
      operation === "tool"
        ? runtime.callTool("sample", "save", {}, { assertCurrent: guard("grant") })
        : operation === "catalog"
          ? runtime.getCatalog()
          : runtime.readResource("sample", "ui://sample/app.html");
    const outcome = request.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const firstWrite = harness.writes[0];
    if (!firstWrite) {
      throw new Error("The admitted App request did not reach the native transport");
    }
    const first = JSON.parse(firstWrite);
    const { method, result: response } = responses[operation];
    expect(first).toMatchObject({ method, params: { threadId: "app-thread" } });
    harness.send({
      id: first.id,
      error: { code: -32001, message: "Server overloaded; retry later." },
    });
    await vi.advanceTimersByTimeAsync(0);
    authority.owner = revoke !== "owner";
    authority.grant = revoke !== "grant";
    await vi.advanceTimersByTimeAsync(1_000);
    const writes = [...harness.writes];
    // Settle an erroneous retry too, so a regression reports the forbidden I/O
    // instead of timing out or leaving an unhandled request behind.
    if (writes[1]) {
      const retry = JSON.parse(writes[1]);
      expect(retry.method).toBe(method);
      harness.send({ id: retry.id, result: response });
    }
    const result = await outcome;
    expect(writes).toHaveLength(revoke === "none" ? 2 : 1);
    if (revoke === "none") {
      expect(result.error).toBeUndefined();
    } else {
      expect(result.error).toBeInstanceOf(CodexAppServerScopedRequestRejectedError);
      expect(result.error).toMatchObject({ message: revocationError.message });
      expect(result.error instanceof Error ? result.error.cause : undefined).toBe(revocationError);
    }
    expect(harness.client.getCloseError()).toBeUndefined();
  },
);

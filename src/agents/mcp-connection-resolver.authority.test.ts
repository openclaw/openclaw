import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConnectionResolved } from "../plugins/types.mcp-connection.js";
import { createDeferredCore } from "../shared/deferred.js";
import { McpConnectionAuthorityError } from "./mcp-connection-authority-error.js";
import { resolveRequesterScopedMcpConnections } from "./mcp-connection-resolver.js";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), pluginId: "fixture" }));
// mock-isolation: Resolver authority tests do not initialize the process-wide plugin registry.
vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: () => ({
    mcpServerConnectionResolvers: [
      {
        pluginId: mocks.pluginId,
        resolver: { serverName: "calendar", resolve: mocks.resolve },
      },
    ],
  }),
}));
// mock-isolation: Resolve against the fixture registry, not an ambient Gateway request.
vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => undefined,
}));
// mock-isolation: Capture resolver diagnostics without initializing global logging.
vi.mock("../logger.js", () => ({ logWarn: vi.fn() }));
const requester = { serverNames: ["calendar"], requesterSenderId: "alice" };
function observation() {
  return {
    authorizationId: "grant-one",
    assertCurrent: vi.fn(),
    revalidate: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
}
afterEach(() => {
  mocks.resolve.mockReset();
  mocks.pluginId = "fixture";
  vi.useRealTimers();
});

describe("MCP resolver authority observation lifecycle", () => {
  it("leaves ordinary tool results unchanged and releases unsolicited observations", async () => {
    const authority = observation();
    mocks.resolve.mockResolvedValue({ url: "https://calendar.example/mcp", authority });
    expect(await resolveRequesterScopedMcpConnections(requester)).toEqual(
      new Map([["calendar", { url: "https://calendar.example/mcp" }]]),
    );
    expect(mocks.resolve).toHaveBeenCalledWith({ requesterSenderId: "alice" });
    expect(authority.dispose).toHaveBeenCalledOnce();
  });
  it("namespaces authorization lifetimes by their actual resolver issuer", async () => {
    mocks.resolve.mockImplementation(() => ({
      url: "https://calendar.example/mcp",
      authority: observation(),
    }));
    const first = (
      await resolveRequesterScopedMcpConnections({ ...requester, retainAuthority: true })
    ).get("calendar")?.authority;
    mocks.pluginId = "replacement-connector";
    const replacement = (
      await resolveRequesterScopedMcpConnections({ ...requester, retainAuthority: true })
    ).get("calendar")?.authority;
    try {
      expect(first).toBeDefined();
      expect(replacement).toBeDefined();
      expect(replacement?.authorizationId).not.toBe(first?.authorizationId);
    } finally {
      first?.dispose();
      replacement?.dispose();
    }
  });

  it("disposes late observations after bounded resolution times out", async () => {
    vi.useFakeTimers();
    const result = createDeferredCore<McpServerConnectionResolved>();
    const authority = observation();
    mocks.resolve.mockReturnValue(result.promise);
    const failure = expect(
      resolveRequesterScopedMcpConnections({ ...requester, retainAuthority: true }),
    ).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    result.resolve({ url: "https://calendar.example/mcp", authority });
    await vi.advanceTimersByTimeAsync(0);
    expect(authority.dispose).toHaveBeenCalledOnce();
  });
  it("revalidates temporarily unavailable observations and retains only sanitized errors", async () => {
    const authority = observation();
    authority.assertCurrent.mockImplementationOnce(() => {});
    mocks.resolve.mockResolvedValue({ url: "https://calendar.example/mcp", authority });
    const retained = (
      await resolveRequesterScopedMcpConnections({ ...requester, retainAuthority: true })
    ).get("calendar")?.authority;
    if (!retained) {
      throw new Error("Missing retained observation");
    }
    authority.assertCurrent.mockImplementation(() => {
      throw new McpConnectionAuthorityError("unavailable");
    });
    authority.revalidate.mockImplementationOnce(async () => {
      authority.assertCurrent.mockImplementation(() => {});
    });
    await retained.revalidate();
    retained.assertCurrent();
    authority.revalidate.mockRejectedValueOnce(new Error("provider credential details"));
    const refused = retained.revalidate();
    await expect(refused).rejects.toMatchObject({ code: "MCP_AUTHORIZATION_UNAVAILABLE" });
    await expect(refused).rejects.not.toHaveProperty("cause");
    retained.dispose();
    retained.dispose();
    expect(authority.dispose).toHaveBeenCalledOnce();
    expect(() => retained.assertCurrent()).toThrow("disconnected or replaced");
  });
});

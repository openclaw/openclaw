import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

vi.mock("@/lib/composio", () => ({
  disconnectComposioApp: vi.fn(),
  resolveComposioApiKey: vi.fn(),
  resolveComposioEligibility: vi.fn(),
  resolveComposioGatewayUrl: vi.fn(),
}));

vi.mock("@/lib/composio-tool-index", () => ({
  rebuildComposioToolIndexIfReady: vi.fn(),
}));

vi.mock("@/lib/composio-mcp-health", () => ({
  getComposioMcpHealth: vi.fn(),
}));

vi.mock("@/lib/integrations", () => ({
  refreshIntegrationsRuntime: vi.fn(),
}));

const {
  disconnectComposioApp,
  resolveComposioApiKey,
  resolveComposioEligibility,
  resolveComposioGatewayUrl,
} = await import("@/lib/composio");
const { rebuildComposioToolIndexIfReady } = await import("@/lib/composio-tool-index");
const { getComposioMcpHealth } = await import("@/lib/composio-mcp-health");
const { refreshIntegrationsRuntime } = await import("@/lib/integrations");

const mockedDisconnectComposioApp = vi.mocked(disconnectComposioApp);
const mockedResolveComposioApiKey = vi.mocked(resolveComposioApiKey);
const mockedResolveComposioEligibility = vi.mocked(resolveComposioEligibility);
const mockedResolveComposioGatewayUrl = vi.mocked(resolveComposioGatewayUrl);
const mockedRebuildComposioToolIndexIfReady = vi.mocked(rebuildComposioToolIndexIfReady);
const mockedGetComposioMcpHealth = vi.mocked(getComposioMcpHealth);
const mockedRefreshIntegrationsRuntime = vi.mocked(refreshIntegrationsRuntime);

describe("Composio disconnect API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedResolveComposioApiKey.mockReturnValue("dc-key");
    mockedResolveComposioEligibility.mockReturnValue({
      eligible: true,
      lockReason: null,
      lockBadge: null,
    });
    mockedResolveComposioGatewayUrl.mockReturnValue("https://gateway.merseoriginals.com");
    mockedDisconnectComposioApp.mockResolvedValue({
      ok: true,
    } as never);
    mockedRebuildComposioToolIndexIfReady.mockResolvedValue({
      ok: true,
      workspaceDir: "/tmp/workspace",
      generated_at: "2026-04-02T00:00:00.000Z",
      connected_apps: 0,
    });
    mockedGetComposioMcpHealth.mockResolvedValue({} as never);
    mockedRefreshIntegrationsRuntime.mockResolvedValue({
      attempted: true,
      restarted: true,
      error: null,
      profile: "dench",
    });
  });

  it("restarts the runtime after rebuilding the index", async () => {
    const response = await POST(
      new Request("http://localhost/api/composio/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connection_id: "conn_123" }),
      }),
    );

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(mockedDisconnectComposioApp).toHaveBeenCalledWith(
      "https://gateway.merseoriginals.com",
      "dc-key",
      "conn_123",
    );
    expect(mockedRebuildComposioToolIndexIfReady).toHaveBeenCalledTimes(1);
    expect(mockedRefreshIntegrationsRuntime).toHaveBeenCalledTimes(1);
    expect(mockedGetComposioMcpHealth).toHaveBeenCalledTimes(1);
    expect(body.runtime_refresh).toMatchObject({
      attempted: true,
      restarted: true,
      profile: "dench",
    });
  });
});

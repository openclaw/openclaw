import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";

vi.mock("@/lib/composio-mcp-health", () => ({
  getComposioMcpHealth: vi.fn(),
}));

const { getComposioMcpHealth } = await import("@/lib/composio-mcp-health");
const mockedGetComposioMcpHealth = vi.mocked(getComposioMcpHealth);

const mockStatus = {
  generatedAt: "2026-04-02T00:00:00.000Z",
  workspaceDir: "/tmp/workspace",
  gatewayUrl: "https://gateway.merseoriginals.com",
  eligible: true,
  lockReason: null,
  lockBadge: null,
  config: {
    status: "pass",
    detail: "ok",
    checkedAt: "2026-04-02T00:00:00.000Z",
    matchesExpected: true,
    configured: { url: "https://gateway.merseoriginals.com/v1/composio/mcp", transport: "streamable-http", authorizationHeader: "Bearer x" },
    expected: { url: "https://gateway.merseoriginals.com/v1/composio/mcp", transport: "streamable-http", authorizationHeader: "Bearer x" },
  },
  gatewayTools: {
    status: "pass",
    detail: "ok",
    checkedAt: "2026-04-02T00:00:00.000Z",
    toolCount: 12,
  },
  liveAgent: {
    status: "unknown",
    detail: "not checked",
    checkedAt: "2026-04-02T00:00:00.000Z",
    visible: null,
    evidence: [],
    toolCallsDetected: false,
  },
  summary: {
    level: "healthy",
    verified: false,
    message: "verification pending",
  },
};

describe("Composio status API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetComposioMcpHealth.mockResolvedValue(mockStatus);
  });

  it("GET returns the current Composio MCP health", async () => {
    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.summary.level).toBe("healthy");
    expect(mockedGetComposioMcpHealth).toHaveBeenCalledWith();
  });

  it("POST repairs MCP registration when requested", async () => {
    const request = new Request("http://localhost/api/composio/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "repair_mcp" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockedGetComposioMcpHealth).toHaveBeenCalledWith({
      repairConfig: true,
      includeLiveAgentProbe: true,
    });
  });

  it("POST runs the live-agent probe when requested", async () => {
    const request = new Request("http://localhost/api/composio/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "probe_live_agent" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(mockedGetComposioMcpHealth).toHaveBeenCalledWith({ includeLiveAgentProbe: true });
  });

  it("POST rejects unknown actions", async () => {
    const request = new Request("http://localhost/api/composio/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toContain("Unknown action");
  });
});

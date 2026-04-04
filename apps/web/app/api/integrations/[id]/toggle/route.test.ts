import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/integrations", () => ({
  normalizeLockedDenchIntegrations: vi.fn(() => ({
    changed: false,
    state: {
      denchCloud: {
        hasKey: true,
        isPrimaryProvider: true,
        primaryModel: "dench-cloud/claude-sonnet-4.6",
      },
      metadata: { schemaVersion: 1, exa: { ownsSearch: false, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: true,
          denied: false,
          provider: "duckduckgo",
        },
        effectiveOwner: "web_search",
      },
      integrations: [
        {
          id: "exa",
          label: "Exa Search",
          enabled: false,
          available: false,
          locked: false,
          lockReason: null,
          lockBadge: null,
          gatewayBaseUrl: "https://gateway.merseoriginals.com",
          auth: { configured: true, source: "config" },
          plugin: null,
          managedByDench: true,
          healthIssues: [],
          health: {
            status: "disabled",
            pluginMissing: false,
            pluginInstalledButDisabled: false,
            configMismatch: false,
            missingAuth: false,
            missingGatewayOverride: false,
          },
        },
        {
          id: "apollo",
          label: "Apollo Enrichment",
          enabled: false,
          available: false,
          locked: false,
          lockReason: null,
          lockBadge: null,
          gatewayBaseUrl: "https://gateway.merseoriginals.com",
          auth: { configured: true, source: "config" },
          plugin: null,
          managedByDench: true,
          healthIssues: [],
          health: {
            status: "disabled",
            pluginMissing: false,
            pluginInstalledButDisabled: false,
            configMismatch: false,
            missingAuth: false,
            missingGatewayOverride: false,
          },
        },
        {
          id: "elevenlabs",
          label: "ElevenLabs",
          enabled: false,
          available: false,
          locked: false,
          lockReason: null,
          lockBadge: null,
          gatewayBaseUrl: "https://gateway.merseoriginals.com",
          auth: { configured: true, source: "config" },
          plugin: null,
          managedByDench: true,
          healthIssues: [],
          health: {
            status: "disabled",
            pluginMissing: false,
            pluginInstalledButDisabled: false,
            configMismatch: false,
            missingAuth: false,
            missingGatewayOverride: false,
          },
        },
      ],
    },
  })),
  setExaIntegrationEnabled: vi.fn((enabled: boolean) => ({
    changed: true,
    error: null,
    state: {
      denchCloud: {
        hasKey: true,
        isPrimaryProvider: true,
        primaryModel: "dench-cloud/claude-sonnet-4.6",
      },
      metadata: { schemaVersion: 1, exa: { ownsSearch: enabled, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: !enabled,
          denied: enabled,
          provider: enabled ? "duckduckgo" : "duckduckgo",
        },
        effectiveOwner: enabled ? "exa" : "web_search",
      },
      integrations: [],
    },
  })),
  setApolloIntegrationEnabled: vi.fn((enabled: boolean) => ({
    changed: true,
    error: null,
    state: {
      denchCloud: {
        hasKey: true,
        isPrimaryProvider: true,
        primaryModel: "dench-cloud/claude-sonnet-4.6",
      },
      metadata: { schemaVersion: 1, exa: { ownsSearch: false, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: true,
          denied: false,
          provider: "duckduckgo",
        },
        effectiveOwner: "web_search",
      },
      integrations: [{ id: "apollo", enabled, available: true }],
    },
  })),
  setElevenLabsIntegrationEnabled: vi.fn((enabled: boolean) => ({
    changed: true,
    error: null,
    state: {
      denchCloud: {
        hasKey: true,
        isPrimaryProvider: true,
        primaryModel: "dench-cloud/claude-sonnet-4.6",
      },
      metadata: { schemaVersion: 1, exa: { ownsSearch: false, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: true,
          denied: false,
          provider: "duckduckgo",
        },
        effectiveOwner: "web_search",
      },
      integrations: [{ id: "elevenlabs", enabled, available: true }],
    },
  })),
  refreshIntegrationsRuntime: vi.fn(() => Promise.resolve({
    attempted: true,
    restarted: true,
    error: null,
    profile: "dench",
  })),
}));

describe("integrations toggle API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("toggles Exa integration", async () => {
    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/exa/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "exa" }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.integration).toBe("exa");
    expect(json.search.effectiveOwner).toBe("exa");
    expect(json.refresh.restarted).toBe(true);
  });

  it("rejects missing enabled boolean", async () => {
    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/exa/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "exa" }) });
    expect(response.status).toBe(400);
  });

  it("toggles Apollo integration", async () => {
    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/apollo/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "apollo" }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.integration).toBe("apollo");
  });

  it("toggles ElevenLabs integration", async () => {
    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/elevenlabs/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "elevenlabs" }) });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.integration).toBe("elevenlabs");
  });

  it("rejects enabling a locked integration", async () => {
    const integrations = await import("@/lib/integrations");
    vi.mocked(integrations.normalizeLockedDenchIntegrations).mockReturnValueOnce({
      changed: false,
      state: {
        denchCloud: {
          hasKey: false,
          isPrimaryProvider: false,
          primaryModel: "anthropic/claude-4",
        },
        metadata: { schemaVersion: 1, exa: { ownsSearch: false, fallbackProvider: "duckduckgo" } },
        search: {
          builtIn: {
            enabled: true,
            denied: false,
            provider: "duckduckgo",
          },
          effectiveOwner: "web_search",
        },
        integrations: [
          {
            id: "exa",
            label: "Exa Search",
            enabled: false,
            available: false,
            locked: true,
            lockReason: "missing_dench_key",
            lockBadge: "Get Dench Cloud API Key",
            gatewayBaseUrl: "https://gateway.merseoriginals.com",
            auth: { configured: false, source: "missing" },
            plugin: null,
            managedByDench: true,
            healthIssues: ["missing_auth"],
            health: {
              status: "disabled",
              pluginMissing: false,
              pluginInstalledButDisabled: false,
              configMismatch: false,
              missingAuth: true,
              missingGatewayOverride: false,
            },
          },
        ],
      },
    });

    const { POST } = await import("./route.js");
    const request = new Request("http://localhost/api/integrations/exa/toggle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: "exa" }) });
    expect(response.status).toBe(409);
    const json = await response.json();
    expect(json.error).toBe("This integration requires a Dench Cloud API key.");
  });
});

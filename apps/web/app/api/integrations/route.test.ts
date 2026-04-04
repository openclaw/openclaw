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
      metadata: { schemaVersion: 1, exa: { ownsSearch: true, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: false,
          denied: true,
          provider: "duckduckgo",
        },
        effectiveOwner: "exa",
      },
      integrations: [
        {
          id: "exa",
          label: "Exa Search",
          enabled: true,
          available: true,
          locked: false,
          lockReason: null,
          lockBadge: null,
          gatewayBaseUrl: "https://gateway.merseoriginals.com",
          auth: { configured: true, source: "config" },
          plugin: null,
          managedByDench: true,
          healthIssues: [],
        },
      ],
    },
  })),
}));

describe("integrations API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("returns normalized integrations state", async () => {
    const { GET } = await import("./route.js");
    const response = await GET();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.search.effectiveOwner).toBe("exa");
    expect(json.metadata.exa.fallbackProvider).toBe("duckduckgo");
    expect(json.integrations[0].id).toBe("exa");
  });
});

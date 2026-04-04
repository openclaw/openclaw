import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/integrations", () => ({
  repairOlderIntegrationsProfile: vi.fn(() => ({
    changed: true,
    repairs: [
      {
        id: "exa",
        pluginId: "exa-search",
        assetAvailable: true,
        assetCopied: true,
        repaired: true,
        issues: [],
      },
    ],
    repairedIds: ["exa"],
    state: {
      metadata: { schemaVersion: 1, exa: { ownsSearch: false, fallbackProvider: "duckduckgo" } },
      search: {
        builtIn: {
          enabled: true,
          denied: false,
          provider: "duckduckgo",
        },
        effectiveOwner: "web_search",
      },
      integrations: [],
    },
  })),
  refreshIntegrationsRuntime: vi.fn(() => Promise.resolve({
    attempted: true,
    restarted: true,
    error: null,
    profile: "dench",
  })),
}));

describe("integrations repair API", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("repairs older profiles and reports restart status", async () => {
    const { POST } = await import("./route.js");
    const response = await POST();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json.changed).toBe(true);
    expect(json.repairedIds).toEqual(["exa"]);
    expect(json.refresh.restarted).toBe(true);
  });
});

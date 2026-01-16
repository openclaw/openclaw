import { describe, expect, it, vi } from "vitest";

const loadSessionStoreMock = vi.fn();
const updateSessionStoreMock = vi.fn();

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    updateSessionStore: async (
      storePath: string,
      mutator: (store: Record<string, unknown>) => Promise<void> | void,
    ) => {
      const store = loadSessionStoreMock(storePath) as Record<string, unknown>;
      await mutator(store);
      updateSessionStoreMock(storePath, store);
      return store;
    },
    resolveStorePath: () => "/tmp/sessions.json",
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => ({
      session: { mainKey: "main", scope: "per-sender" },
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
          models: {},
        },
      },
    }),
  };
});

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: async () => [
    {
      provider: "anthropic",
      id: "claude-opus-4-5",
      name: "Opus",
      contextWindow: 200000,
    },
    {
      provider: "anthropic",
      id: "claude-sonnet-4-5",
      name: "Sonnet",
      contextWindow: 200000,
    },
  ],
}));

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
  resolveAuthProfileDisplayLabel: () => undefined,
  resolveAuthProfileOrder: () => [],
}));

vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey: () => null,
  getCustomProviderApiKey: () => null,
  resolveModelAuthMode: () => "api-key",
}));

vi.mock("../infra/provider-usage.js", () => ({
  resolveUsageProviderId: () => undefined,
  loadProviderUsageSummary: async () => ({
    updatedAt: Date.now(),
    providers: [],
  }),
  formatUsageSummaryLine: () => null,
}));

import { createClawdbotTools } from "./clawdbot-tools.js";

describe("session_status tool", () => {
  it("returns a status card for the current session", async () => {
    loadSessionStoreMock.mockReset();
    updateSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({
      main: {
        sessionId: "s1",
        updatedAt: 10,
      },
    });

    const tool = createClawdbotTools({ agentSessionKey: "main" }).find(
      (candidate) => candidate.name === "session_status",
    );
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing session_status tool");

    const result = await tool.execute("call1", {});
    const details = result.details as { ok?: boolean; statusText?: string };
    expect(details.ok).toBe(true);
    expect(details.statusText).toContain("Clawdbot");
    expect(details.statusText).toContain("🧠 Model:");
    expect(details.statusText).not.toContain("OAuth/token status");
  });

  it("errors for unknown session keys", async () => {
    loadSessionStoreMock.mockReset();
    updateSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = createClawdbotTools({ agentSessionKey: "main" }).find(
      (candidate) => candidate.name === "session_status",
    );
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing session_status tool");

    await expect(tool.execute("call2", { sessionKey: "nope" })).rejects.toThrow(
      "Unknown sessionKey",
    );
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("resets per-session model override via model=default", async () => {
    loadSessionStoreMock.mockReset();
    updateSessionStoreMock.mockReset();
    loadSessionStoreMock.mockReturnValue({
      main: {
        sessionId: "s1",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-5",
        authProfileOverride: "p1",
      },
    });

    const tool = createClawdbotTools({ agentSessionKey: "main" }).find(
      (candidate) => candidate.name === "session_status",
    );
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing session_status tool");

    await tool.execute("call3", { model: "default" });
    expect(updateSessionStoreMock).toHaveBeenCalled();
    const [, savedStore] = updateSessionStoreMock.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    const saved = savedStore.main as Record<string, unknown>;
    expect(saved.providerOverride).toBeUndefined();
    expect(saved.modelOverride).toBeUndefined();
    expect(saved.authProfileOverride).toBeUndefined();
  });
});

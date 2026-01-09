import { describe, expect, it, vi } from "vitest";

const loadSessionStoreMock = vi.fn();
const saveSessionStoreMock = vi.fn();

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    loadSessionStore: (storePath: string) => loadSessionStoreMock(storePath),
    saveSessionStore: (storePath: string, store: Record<string, unknown>) =>
      saveSessionStoreMock(storePath, store),
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
    saveSessionStoreMock.mockReset();
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
    expect(details.statusText).toContain("ClawdBot");
    expect(details.statusText).toContain("🧠 Model:");
  });

  it("errors for unknown session keys", async () => {
    loadSessionStoreMock.mockReset();
    saveSessionStoreMock.mockReset();
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
    expect(saveSessionStoreMock).not.toHaveBeenCalled();
  });

  it("resets per-session model override via model=default", async () => {
    loadSessionStoreMock.mockReset();
    saveSessionStoreMock.mockReset();
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
    expect(saveSessionStoreMock).toHaveBeenCalled();
    const [, savedStore] = saveSessionStoreMock.mock.calls.at(-1) as [
      string,
      Record<string, unknown>,
    ];
    const saved = savedStore.main as Record<string, unknown>;
    expect(saved.providerOverride).toBeUndefined();
    expect(saved.modelOverride).toBeUndefined();
    expect(saved.authProfileOverride).toBeUndefined();
  });
});

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
    resolveStorePath: (_store: string | undefined, _opts?: { agentId?: string }) =>
      "/tmp/main/sessions.json",
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
          model: { primary: "anthropic/claude-sonnet-4" },
          models: {
            "anthropic/claude-sonnet-4": { alias: "sonnet" },
            "anthropic/claude-opus-4": { alias: "opus" },
            "openai/gpt-4o": { alias: "gpt4o" },
          },
        },
      },
    }),
  };
});

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: async () => [
    { provider: "anthropic", id: "claude-sonnet-4", name: "Sonnet", contextWindow: 200000 },
    { provider: "anthropic", id: "claude-opus-4", name: "Opus", contextWindow: 200000 },
    { provider: "openai", id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 },
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

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

function resetSessionStore(store: Record<string, unknown>) {
  loadSessionStoreMock.mockClear();
  updateSessionStoreMock.mockClear();
  loadSessionStoreMock.mockReturnValue(store);
}

function getSwitchModelTool(agentSessionKey = "main") {
  const tool = createOpenClawTools({ agentSessionKey }).find(
    (candidate) => candidate.name === "switch_model",
  );
  expect(tool).toBeDefined();
  if (!tool) {
    throw new Error("missing switch_model tool");
  }
  return tool;
}

describe("switch_model tool", () => {
  it("is registered in openclaw tools", () => {
    resetSessionStore({ main: { sessionId: "s1", updatedAt: 10 } });
    const tools = createOpenClawTools({ agentSessionKey: "main" });
    expect(tools.some((t) => t.name === "switch_model")).toBe(true);
  });

  it("switches to a model by exact provider/model", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSwitchModelTool();
    const result = await tool.execute("call1", { model: "openai/gpt-4o" });
    const details = result.details as { ok?: boolean; newModel?: string };
    expect(details.ok).toBe(true);
    expect(details.newModel).toBe("openai/gpt-4o");
    expect(updateSessionStoreMock).toHaveBeenCalled();
  });

  it("switches to a model by alias", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSwitchModelTool();
    const result = await tool.execute("call2", { model: "opus" });
    const details = result.details as { ok?: boolean; newModel?: string; alias?: string };
    expect(details.ok).toBe(true);
    expect(details.newModel).toBe("anthropic/claude-opus-4");
    expect(details.alias).toBe("opus");
  });

  it("resets to default with model=default", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
        providerOverride: "openai",
        modelOverride: "gpt-4o",
      },
    });

    const tool = getSwitchModelTool();
    const result = await tool.execute("call3", { model: "default" });
    const details = result.details as { ok?: boolean; isDefault?: boolean };
    expect(details.ok).toBe(true);
    expect(details.isDefault).toBe(true);
    expect(updateSessionStoreMock).toHaveBeenCalled();
  });

  it("resets to default with model=reset", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
        providerOverride: "openai",
        modelOverride: "gpt-4o",
      },
    });

    const tool = getSwitchModelTool();
    const result = await tool.execute("call4", { model: "reset" });
    const details = result.details as { ok?: boolean; isDefault?: boolean };
    expect(details.ok).toBe(true);
    expect(details.isDefault).toBe(true);
  });

  it("errors on empty model parameter", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSwitchModelTool();
    await expect(tool.execute("call5", { model: "" })).rejects.toThrow("model parameter");
  });

  it("errors for unrecognized model", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSwitchModelTool();
    await expect(tool.execute("call6", { model: "nonexistent/model-xyz" })).rejects.toThrow();
  });

  it("errors when sessionKey is missing", async () => {
    resetSessionStore({});
    const tools = createOpenClawTools({});
    const tool = tools.find((t) => t.name === "switch_model");
    expect(tool).toBeDefined();
    await expect(tool!.execute("call7", { model: "opus" })).rejects.toThrow("sessionKey required");
  });

  it("returns previous and new model in details", async () => {
    resetSessionStore({
      main: {
        sessionId: "s1",
        updatedAt: 10,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4",
      },
    });

    const tool = getSwitchModelTool();
    const result = await tool.execute("call8", { model: "opus" });
    const details = result.details as { previousModel?: string; newModel?: string };
    expect(details.previousModel).toBe("anthropic/claude-sonnet-4");
    expect(details.newModel).toBe("anthropic/claude-opus-4");
  });

  it("is marked as ownerOnly", () => {
    resetSessionStore({ main: { sessionId: "s1", updatedAt: 10 } });
    const tool = getSwitchModelTool();
    expect((tool as { ownerOnly?: boolean }).ownerOnly).toBe(true);
  });

  it("returns ambiguous candidates when multiple models match closely", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSwitchModelTool();
    const result = await tool.execute("call-ambig", { model: "claude" });
    const details = result.details as {
      ok?: boolean;
      ambiguous?: boolean;
      candidates?: Array<{ provider: string; model: string; alias?: string }>;
    };
    expect(details.ambiguous).toBe(true);
    expect(details.ok).toBe(false);
    expect(details.candidates).toBeDefined();
    expect(details.candidates!.length).toBeGreaterThanOrEqual(2);
    const models = details.candidates!.map((c) => `${c.provider}/${c.model}`);
    expect(models).toContain("anthropic/claude-sonnet-4");
    expect(models).toContain("anthropic/claude-opus-4");
    expect(updateSessionStoreMock).not.toHaveBeenCalled();
  });

  it("does not return ambiguity when a single model matches clearly", async () => {
    resetSessionStore({
      main: { sessionId: "s1", updatedAt: 10 },
    });

    const tool = getSwitchModelTool();
    const result = await tool.execute("call-clear", { model: "gpt-4o" });
    const details = result.details as { ok?: boolean; ambiguous?: boolean; newModel?: string };
    expect(details.ok).toBe(true);
    expect(details.ambiguous).toBeUndefined();
    expect(details.newModel).toBe("openai/gpt-4o");
  });
});

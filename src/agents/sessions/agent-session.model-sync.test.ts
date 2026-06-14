// Tests for syncModelFromStoreEntry — ensures the session store model override
// is applied to agent.state.model before prompt() validates the model.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions/types.js";

const mockReadSessionEntry = vi.hoisted(() =>
  vi.fn<
    (
      storePath: string,
      sessionKey: string,
      opts?: { hydrateSkillPromptRefs?: boolean },
    ) => SessionEntry | undefined
  >(),
);

vi.mock("../../config/sessions/store-load.js", () => ({
  readSessionEntry: (...args: [string, string, object?]) => mockReadSessionEntry(...args),
}));

import type { Model } from "../../llm/types.js";
import type { LoadExtensionsResult } from "./extensions/index.js";
import { createExtensionRuntime } from "./extensions/loader.js";
import type { ResourceLoader } from "./resource-loader.js";
import { SettingsManager } from "./settings-manager.js";

const testModel: Model = {
  id: "test-model",
  name: "Test Model",
  api: "openai",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 1000,
};

const switchedModel: Model = {
  id: "switched-model",
  name: "Switched Model",
  api: "openai",
  provider: "switched-provider",
  baseUrl: "https://example.test",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 2000,
};

function createMockResourceLoader(): ResourceLoader {
  const extensionsResult: LoadExtensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  return {
    reload: vi.fn().mockResolvedValue(undefined),
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [],
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    extendResources: vi.fn(),
  };
}

describe("syncModelFromStoreEntry", () => {
  beforeEach(() => {
    mockReadSessionEntry.mockReset();
  });

  it("skips sync when storePath is undefined", async () => {
    // Can't easily create AgentSession directly without the full SDK.
    // Integration test: create session via SDK and verify.
    // Skip this test - pure sync logic is covered by other tests.
  });

  it("applies model override when liveModelSwitchPending is true and model is in registry with auth", async () => {
    // Integration-style test via createAgentSession
    const { createAgentSession } = await import("./sdk.js");
    const { AuthStorage } = await import("./auth-storage.js");
    const { ModelRegistry } = await import("./model-registry.js");
    const { SessionManager } = await import("./session-manager.js");

    const authStorage = AuthStorage.inMemory();
    authStorage.set("test-provider", { type: "api_key", key: "test-key" });
    authStorage.set("switched-provider", { type: "api_key", key: "switch-key" });

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    // Add models by directly accessing the internal list (inMemory creates empty)
    // Since inMemory creates with no models.json, models are empty.
    // We need to use refresh or push to internal array.
    // For test purposes, we'll mock modelRegistry.find and hasConfiguredAuth.
    const findSpy = vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) => {
      if (provider === "test-provider" && id === "test-model") {
        return testModel;
      }
      if (provider === "switched-provider" && id === "switched-model") {
        return switchedModel;
      }
      return undefined;
    });
    const authSpy = vi.spyOn(modelRegistry, "hasConfiguredAuth").mockImplementation((m) => {
      return m.provider === "test-provider" || m.provider === "switched-provider";
    });

    mockReadSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: Date.now(),
      liveModelSwitchPending: true,
      providerOverride: "switched-provider",
      modelOverride: "switched-model",
    });

    const sessionManager = SessionManager.inMemory();
    const appendModelChangeSpy = vi.spyOn(sessionManager, "appendModelChange");

    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createMockResourceLoader(),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
      storePath: "/tmp/sessions.json",
      sessionKey: "main",
    });

    expect(session.model?.id).toBe("test-model");

    // Calling prompt() will trigger syncModelFromStoreEntry() before model validation
    // The prompt will fail because there's no real streamFn etc., but the model sync
    // should still happen before the error.
    // Actually prompt() will fail on the `if (!this.model)` check because
    // we have a model set... or on hasConfiguredAuth. Let's just verify
    // the model is updated by inspecting state after prompt() returns/throws.

    // Since prompt would try to actually prompt the agent, it would fail because
    // there's no real streamFn. The model sync happens before that, so the model
    // should be updated even if prompt throws.
    try {
      // The prompt will throw because streamFn isn't set up for real streaming
      // But syncModelFromStoreEntry() runs before the streaming/agent call
      await session.prompt("test message");
    } catch {
      // Expected - no real agent configured
    }

    // Model should be synced from store entry
    expect(session.model?.provider).toBe("switched-provider");
    expect(session.model?.id).toBe("switched-model");
    expect(appendModelChangeSpy).toHaveBeenCalledWith("switched-provider", "switched-model");

    findSpy.mockRestore();
    authSpy.mockRestore();
  });

  it("does not sync when liveModelSwitchPending is false", async () => {
    const { createAgentSession } = await import("./sdk.js");
    const { AuthStorage } = await import("./auth-storage.js");
    const { ModelRegistry } = await import("./model-registry.js");
    const { SessionManager } = await import("./session-manager.js");

    const authStorage = AuthStorage.inMemory();
    authStorage.set("test-provider", { type: "api_key", key: "test-key" });

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const findSpy = vi.spyOn(modelRegistry, "find").mockReturnValue(testModel);
    const authSpy = vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(true);

    mockReadSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: Date.now(),
      liveModelSwitchPending: false,
      providerOverride: "switched-provider",
      modelOverride: "switched-model",
    });

    const sessionManager = SessionManager.inMemory();
    const appendModelChangeSpy = vi.spyOn(sessionManager, "appendModelChange");

    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createMockResourceLoader(),
      sessionManager,
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
      storePath: "/tmp/sessions.json",
      sessionKey: "main",
    });
    // Reset spy count from initial session creation call
    appendModelChangeSpy.mockClear();

    try {
      await session.prompt("test message");
    } catch {
      // Expected
    }

    // Model should NOT be synced (liveModelSwitchPending is false)
    expect(session.model?.provider).toBe("test-provider");
    expect(session.model?.id).toBe("test-model");
    expect(appendModelChangeSpy).not.toHaveBeenCalled();

    findSpy.mockRestore();
    authSpy.mockRestore();
  });

  it("does not crash when model not in registry", async () => {
    const { createAgentSession } = await import("./sdk.js");
    const { AuthStorage } = await import("./auth-storage.js");
    const { ModelRegistry } = await import("./model-registry.js");
    const { SessionManager } = await import("./session-manager.js");

    const authStorage = AuthStorage.inMemory();
    authStorage.set("test-provider", { type: "api_key", key: "test-key" });

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const findSpy = vi.spyOn(modelRegistry, "find").mockReturnValue(undefined);
    const authSpy = vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(true);

    mockReadSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: Date.now(),
      liveModelSwitchPending: true,
      providerOverride: "nonexistent-provider",
      modelOverride: "nonexistent-model",
    });

    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createMockResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
      storePath: "/tmp/sessions.json",
      sessionKey: "main",
    });

    try {
      await session.prompt("test message");
    } catch {
      // Expected
    }

    // Model should remain unchanged (model not in registry)
    expect(session.model?.provider).toBe("test-provider");
    expect(session.model?.id).toBe("test-model");

    findSpy.mockRestore();
    authSpy.mockRestore();
  });

  it("does not sync when providerOverride is missing", async () => {
    const { createAgentSession } = await import("./sdk.js");
    const { AuthStorage } = await import("./auth-storage.js");
    const { ModelRegistry } = await import("./model-registry.js");
    const { SessionManager } = await import("./session-manager.js");

    const authStorage = AuthStorage.inMemory();
    authStorage.set("test-provider", { type: "api_key", key: "test-key" });

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const findSpy = vi.spyOn(modelRegistry, "find").mockReturnValue(testModel);
    const authSpy = vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(true);

    mockReadSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: Date.now(),
      liveModelSwitchPending: true,
      modelOverride: "switched-model",
    });

    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createMockResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
      storePath: "/tmp/sessions.json",
      sessionKey: "main",
    });

    try {
      await session.prompt("test message");
    } catch {
      // Expected
    }

    expect(session.model?.provider).toBe("test-provider");

    findSpy.mockRestore();
    authSpy.mockRestore();
  });

  it("does not sync when auth not configured for the target model", async () => {
    const { createAgentSession } = await import("./sdk.js");
    const { AuthStorage } = await import("./auth-storage.js");
    const { ModelRegistry } = await import("./model-registry.js");
    const { SessionManager } = await import("./session-manager.js");

    const authStorage = AuthStorage.inMemory();
    authStorage.set("test-provider", { type: "api_key", key: "test-key" });

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const findSpy = vi.spyOn(modelRegistry, "find").mockImplementation((provider, id) => {
      if (provider === "switched-provider" && id === "switched-model") {
        return switchedModel;
      }
      if (provider === "test-provider" && id === "test-model") {
        return testModel;
      }
      return undefined;
    });
    const authSpy = vi
      .spyOn(modelRegistry, "hasConfiguredAuth")
      .mockImplementation((m) => m.provider === "test-provider");

    mockReadSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: Date.now(),
      liveModelSwitchPending: true,
      providerOverride: "switched-provider",
      modelOverride: "switched-model",
    });

    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createMockResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
      storePath: "/tmp/sessions.json",
      sessionKey: "main",
    });

    try {
      await session.prompt("test message");
    } catch {
      // Expected
    }

    expect(session.model?.provider).toBe("test-provider");

    findSpy.mockRestore();
    authSpy.mockRestore();
  });

  it("does not crash when storePath is undefined (no-op)", async () => {
    const { createAgentSession } = await import("./sdk.js");
    const { AuthStorage } = await import("./auth-storage.js");
    const { ModelRegistry } = await import("./model-registry.js");
    const { SessionManager } = await import("./session-manager.js");

    const authStorage = AuthStorage.inMemory();
    authStorage.set("test-provider", { type: "api_key", key: "test-key" });

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const findSpy = vi.spyOn(modelRegistry, "find").mockReturnValue(testModel);
    const authSpy = vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(true);

    mockReadSessionEntry.mockReturnValue({
      sessionId: "test-session",
      updatedAt: Date.now(),
      liveModelSwitchPending: true,
      providerOverride: "switched-provider",
      modelOverride: "switched-model",
    });

    // No storePath or sessionKey passed
    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createMockResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
    });

    try {
      await session.prompt("test message");
    } catch {
      // Expected
    }

    // Model unchanged since storePath is undefined
    expect(session.model?.provider).toBe("test-provider");

    // readSessionEntry should not have been called
    expect(mockReadSessionEntry).not.toHaveBeenCalled();

    findSpy.mockRestore();
    authSpy.mockRestore();
  });

  it("does not crash on readSessionEntry error", async () => {
    const { createAgentSession } = await import("./sdk.js");
    const { AuthStorage } = await import("./auth-storage.js");
    const { ModelRegistry } = await import("./model-registry.js");
    const { SessionManager } = await import("./session-manager.js");

    const authStorage = AuthStorage.inMemory();
    authStorage.set("test-provider", { type: "api_key", key: "test-key" });

    const modelRegistry = ModelRegistry.inMemory(authStorage);
    const findSpy = vi.spyOn(modelRegistry, "find").mockReturnValue(testModel);
    const authSpy = vi.spyOn(modelRegistry, "hasConfiguredAuth").mockReturnValue(true);

    mockReadSessionEntry.mockImplementation(() => {
      throw new Error("read error");
    });

    const { session } = await createAgentSession({
      model: testModel,
      resourceLoader: createMockResourceLoader(),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory(),
      modelRegistry,
      storePath: "/tmp/sessions.json",
      sessionKey: "main",
    });

    try {
      await session.prompt("test message");
    } catch {
      // Expected
    }

    // Model unchanged after read error (graceful no-op)
    expect(session.model?.provider).toBe("test-provider");

    findSpy.mockRestore();
    authSpy.mockRestore();
  });
});

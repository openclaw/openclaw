import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";

const state = vi.hoisted(() => ({
  abortEmbeddedPiRunMock: vi.fn(),
  requestEmbeddedRunModelSwitchMock: vi.fn(),
  consumeEmbeddedRunModelSwitchMock: vi.fn(),
  resolveDefaultModelForAgentMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
}));

vi.mock("./pi-embedded.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => state.abortEmbeddedPiRunMock(...args),
}));

vi.mock("./pi-embedded-runner/runs.js", () => ({
  requestEmbeddedRunModelSwitch: (...args: unknown[]) =>
    state.requestEmbeddedRunModelSwitchMock(...args),
  consumeEmbeddedRunModelSwitch: (...args: unknown[]) =>
    state.consumeEmbeddedRunModelSwitchMock(...args),
}));

vi.mock("./model-selection.js", () => ({
  resolveDefaultModelForAgent: (...args: unknown[]) =>
    state.resolveDefaultModelForAgentMock(...args),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStoreMock(...args),
  resolveStorePath: (...args: unknown[]) => state.resolveStorePathMock(...args),
}));

async function loadModule() {
  return await importFreshModule<typeof import("./live-model-switch.js")>(
    import.meta.url,
    `./live-model-switch.js?scope=${Math.random().toString(36).slice(2)}`,
  );
}

describe("live model switch", () => {
  beforeEach(() => {
    vi.resetModules();
    state.abortEmbeddedPiRunMock.mockReset().mockReturnValue(false);
    state.requestEmbeddedRunModelSwitchMock.mockReset();
    state.consumeEmbeddedRunModelSwitchMock.mockReset();
    state.resolveDefaultModelForAgentMock
      .mockReset()
      .mockReturnValue({ provider: "anthropic", model: "claude-opus-4-6" });
    state.loadSessionStoreMock.mockReset().mockReturnValue({});
    state.resolveStorePathMock.mockReset().mockReturnValue("/tmp/session-store.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves persisted session overrides ahead of agent defaults", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        authProfileOverride: "profile-gpt",
        authProfileOverrideSource: "user",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-gpt",
      authProfileIdSource: "user",
    });
    expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalledWith({
      cfg: { session: { store: "/tmp/custom-store.json" } },
      agentId: "reply",
    });
    expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
      agentId: "reply",
    });
  });

  it("prefers persisted runtime model fields ahead of session overrides", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "anthropic",
        modelOverride: "claude-opus-4-6",
        modelProvider: "anthropic",
        model: "claude-sonnet-4-6",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "openai",
        defaultModel: "gpt-5.4",
      }),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("queues a live switch only when an active run was aborted", async () => {
    state.abortEmbeddedPiRunMock.mockReturnValue(true);

    const { requestLiveSessionModelSwitch } = await loadModule();

    expect(
      requestLiveSessionModelSwitch({
        sessionEntry: { sessionId: "session-1" },
        selection: { provider: "openai", model: "gpt-5.4", authProfileId: "profile-gpt" },
      }),
    ).toBe(true);
    expect(state.abortEmbeddedPiRunMock).toHaveBeenCalledWith("session-1");
    expect(state.requestEmbeddedRunModelSwitchMock).toHaveBeenCalledWith("session-1", {
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: "profile-gpt",
    });
  });

  it("treats auth-profile-source changes as no-op when no auth profile is selected", async () => {
    const { hasDifferentLiveSessionModelSelection } = await loadModule();

    expect(
      hasDifferentLiveSessionModelSelection(
        {
          provider: "openai",
          model: "gpt-5.4",
          authProfileIdSource: "auto",
        },
        {
          provider: "openai",
          model: "gpt-5.4",
        },
      ),
    ).toBe(false);
  });

  it("does not track persisted live selection when the run started on a transient model override", async () => {
    const { shouldTrackPersistedLiveSessionModelSelection } = await loadModule();

    expect(
      shouldTrackPersistedLiveSessionModelSelection(
        {
          provider: "anthropic",
          model: "claude-haiku-4-5",
        },
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
        },
      ),
    ).toBe(false);
  });

  // ---- New tests for #57063 fix ----

  it("uses caller-supplied defaults when session has no modelOverride (#57063)", async () => {
    // Simulate a child/heartbeat session with no modelOverride in the store.
    // The caller passes the resolved model (e.g. inherited from parent) as defaults.
    // The config default is different (anthropic/claude-opus-4-6).
    state.loadSessionStoreMock.mockReturnValue({
      "child-session": {
        sessionId: "child-1",
        updatedAt: Date.now(),
        // No modelOverride, no providerOverride
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    const result = resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/store.json" } },
      sessionKey: "child-session",
      agentId: "reply",
      defaultProvider: "google",
      defaultModel: "gemini-3-flash-preview",
    });

    // Should use the caller-supplied defaults, NOT the config default
    expect(result).toEqual({
      provider: "google",
      model: "gemini-3-flash-preview",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    // resolveDefaultModelForAgent should NOT be called when there is no
    // explicit override (lazy evaluation after greptile review feedback).
    expect(state.resolveDefaultModelForAgentMock).not.toHaveBeenCalled();
  });

  it("uses caller-supplied defaults when session entry does not exist (#57063)", async () => {
    // Session key not in the store at all (brand new session)
    state.loadSessionStoreMock.mockReturnValue({});

    const { resolveLiveSessionModelSelection } = await loadModule();

    const result = resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/store.json" } },
      sessionKey: "new-session",
      agentId: "reply",
      defaultProvider: "openrouter",
      defaultModel: "arcee-ai/trinity-large-preview:free",
    });

    expect(result).toEqual({
      provider: "openrouter",
      model: "arcee-ai/trinity-large-preview:free",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("still honours explicit modelOverride from session store", async () => {
    // When the user explicitly set a model override via /model, it should
    // take precedence over the caller-supplied defaults.
    state.loadSessionStoreMock.mockReturnValue({
      "user-session": {
        sessionId: "user-1",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    const result = resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/store.json" } },
      sessionKey: "user-session",
      agentId: "reply",
      defaultProvider: "google",
      defaultModel: "gemini-3-flash-preview",
    });

    // Should use the explicit override, not the caller defaults
    expect(result).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    // resolveDefaultModelForAgent SHOULD be called when there is an explicit
    // override (it provides the fallback provider when providerOverride is absent).
    expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalledWith({
      cfg: { session: { store: "/tmp/store.json" } },
      agentId: "reply",
    });
  });

  it("does not trigger spurious switch for heartbeat model (#56788)", async () => {
    // Heartbeat session: the auto-reply layer resolved the heartbeat model,
    // passed it as defaultProvider/defaultModel. The session store has no
    // modelOverride. The live selection should match the heartbeat model.
    state.loadSessionStoreMock.mockReturnValue({
      "main:heartbeat": {
        sessionId: "hb-1",
        updatedAt: Date.now(),
        // No modelOverride - heartbeat sessions typically don't have one
      },
    });

    const { resolveLiveSessionModelSelection, hasDifferentLiveSessionModelSelection } =
      await loadModule();

    const heartbeatProvider = "openrouter";
    const heartbeatModel = "arcee-ai/trinity-large-preview:free";

    const selection = resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/store.json" } },
      sessionKey: "main:heartbeat",
      agentId: "reply",
      defaultProvider: heartbeatProvider,
      defaultModel: heartbeatModel,
    });

    // The live selection should match the heartbeat model
    expect(
      hasDifferentLiveSessionModelSelection(
        { provider: heartbeatProvider, model: heartbeatModel },
        selection,
      ),
    ).toBe(false);
  });

  it("does not trigger spurious switch for parent-inherited model (#57063)", async () => {
    // Thread/child session: the auto-reply layer resolved the parent's
    // modelOverride and passed it as defaultProvider/defaultModel.
    // The child session store has no modelOverride of its own.
    state.loadSessionStoreMock.mockReturnValue({
      "main:thread:123": {
        sessionId: "thread-1",
        updatedAt: Date.now(),
        // No modelOverride - inherited from parent at the auto-reply layer
      },
    });

    const { resolveLiveSessionModelSelection, hasDifferentLiveSessionModelSelection } =
      await loadModule();

    const inheritedProvider = "openai";
    const inheritedModel = "gpt-5.4";

    const selection = resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/store.json" } },
      sessionKey: "main:thread:123",
      agentId: "reply",
      defaultProvider: inheritedProvider,
      defaultModel: inheritedModel,
    });

    expect(
      hasDifferentLiveSessionModelSelection(
        { provider: inheritedProvider, model: inheritedModel },
        selection,
      ),
    ).toBe(false);
  });

  it("detects genuine live model switch when user changes model via /model", async () => {
    // User changed model via /model while a run was in progress.
    // The session store now has a different modelOverride.
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        sessionId: "main-1",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
      },
    });

    const { resolveLiveSessionModelSelection, hasDifferentLiveSessionModelSelection } =
      await loadModule();

    const selection = resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/store.json" } },
      sessionKey: "main",
      agentId: "reply",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
    });

    // Should detect the switch: current model is anthropic/claude-opus-4-6,
    // but the store says openai/gpt-5.4
    expect(
      hasDifferentLiveSessionModelSelection(
        { provider: "anthropic", model: "claude-opus-4-6" },
        selection,
      ),
    ).toBe(true);
  });

  it("uses caller defaults without agentId (no resolveDefaultModelForAgent call)", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      "no-agent": {
        sessionId: "na-1",
        updatedAt: Date.now(),
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    const result = resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/store.json" } },
      sessionKey: "no-agent",
      // No agentId
      defaultProvider: "google",
      defaultModel: "gemini-3-flash-preview",
    });

    expect(result).toEqual({
      provider: "google",
      model: "gemini-3-flash-preview",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    // resolveDefaultModelForAgent should NOT be called when no agentId
    expect(state.resolveDefaultModelForAgentMock).not.toHaveBeenCalled();
  });
});

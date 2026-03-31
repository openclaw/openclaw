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

  it("prefers session overrides over persisted runtime model fields", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelProvider: "google",
        model: "gemini-3-flash-preview",
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
    ).toEqual(expect.objectContaining({ provider: "openai", model: "gpt-5.4" }));
  });

  it("resolves runtime model/provider when no overrides are set (cron scenario)", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      "agent:main:cron:abc": {
        modelProvider: "google",
        model: "gemini-3-flash-preview",
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/store.json" } },
        sessionKey: "agent:main:cron:abc",
        agentId: "main",
        defaultProvider: "google",
        defaultModel: "gemini-3-flash-preview",
      }),
    ).toEqual(
      expect.objectContaining({
        provider: "google",
        model: "gemini-3-flash-preview",
      }),
    );
  });

  it("does not mix provider from runtime tier with model from override tier", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelProvider: "google",
        model: "gemini-3-flash-preview",
        modelOverride: "gpt-5.4",
        // providerOverride intentionally absent
      },
    });

    const { resolveLiveSessionModelSelection } = await loadModule();

    const result = resolveLiveSessionModelSelection({
      cfg: { session: { store: "/tmp/store.json" } },
      sessionKey: "main",
      agentId: "reply",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
    });

    // model comes from override tier, so provider should NOT come from runtime tier
    expect(result).toEqual(expect.objectContaining({ model: "gpt-5.4" }));
    expect(result!.provider).not.toBe("google");
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
});

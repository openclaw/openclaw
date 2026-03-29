import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";

const state = vi.hoisted(() => ({
  abortEmbeddedPiRunMock: vi.fn(),
  requestEmbeddedRunModelSwitchMock: vi.fn(),
  consumeEmbeddedRunModelSwitchMock: vi.fn(),
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
    state.loadSessionStoreMock.mockReset().mockReturnValue({});
    state.resolveStorePathMock.mockReset().mockReturnValue("/tmp/session-store.json");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("resolves persisted session overrides ahead of the current selection", async () => {
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
    expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
      agentId: "reply",
    });
  });

  it("falls back to the current attempt when the session has no explicit override", async () => {
    const { resolveLiveSessionModelSelection } = await loadModule();

    expect(
      resolveLiveSessionModelSelection({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: "main",
        agentId: "reply",
        defaultProvider: "groq",
        defaultModel: "llama-4",
      }),
    ).toEqual({
      provider: "groq",
      model: "llama-4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
    expect(state.resolveStorePathMock).toHaveBeenCalledWith("/tmp/custom-store.json", {
      agentId: "reply",
    });
  });

  it("ignores auto-selected auth profile overrides when resolving persisted selection", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        authProfileOverride: "anthropic:default",
        authProfileOverrideSource: "auto",
        authProfileOverrideCompactionCount: 2,
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
      provider: "openai",
      model: "gpt-5.4",
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
});

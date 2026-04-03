import { beforeEach, describe, expect, it, vi } from "vitest";
import { importFreshModule } from "../../test/helpers/import-fresh.js";

const state = vi.hoisted(() => ({
  abortEmbeddedPiRunMock: vi.fn(),
  requestEmbeddedRunModelSwitchMock: vi.fn(),
  consumeEmbeddedRunModelSwitchMock: vi.fn(),
  resolveDefaultModelForAgentMock: vi.fn(),
  resolvePersistedModelRefMock: vi.fn(),
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
  resolvePersistedModelRef: (...args: unknown[]) => state.resolvePersistedModelRefMock(...args),
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
    state.abortEmbeddedPiRunMock.mockReset().mockReturnValue(false);
    state.requestEmbeddedRunModelSwitchMock.mockReset();
    state.consumeEmbeddedRunModelSwitchMock.mockReset();
    state.resolveDefaultModelForAgentMock
      .mockReset()
      .mockReturnValue({ provider: "anthropic", model: "claude-opus-4-6" });
    state.resolvePersistedModelRefMock
      .mockReset()
      .mockImplementation(
        (params: {
          defaultProvider: string;
          runtimeProvider?: string;
          runtimeModel?: string;
          overrideProvider?: string;
          overrideModel?: string;
        }) => {
          const defaultProvider = params.defaultProvider.trim();
          const runtimeProvider = params.runtimeProvider?.trim();
          const runtimeModel = params.runtimeModel?.trim();
          if (runtimeModel) {
            if (runtimeProvider) {
              return { provider: runtimeProvider, model: runtimeModel };
            }
            const slash = runtimeModel.indexOf("/");
            if (slash <= 0 || slash === runtimeModel.length - 1) {
              return { provider: defaultProvider, model: runtimeModel };
            }
            return {
              provider: runtimeModel.slice(0, slash),
              model: runtimeModel.slice(slash + 1),
            };
          }
          const overrideProvider = params.overrideProvider?.trim();
          const overrideModel = params.overrideModel?.trim();
          if (!overrideModel) {
            return null;
          }
          if (overrideProvider) {
            return { provider: overrideProvider, model: overrideModel };
          }
          const slash = overrideModel.indexOf("/");
          if (slash <= 0 || slash === overrideModel.length - 1) {
            return { provider: defaultProvider, model: overrideModel };
          }
          return {
            provider: overrideModel.slice(0, slash),
            model: overrideModel.slice(slash + 1),
          };
        },
      );
    state.loadSessionStoreMock.mockReset().mockReturnValue({});
    state.resolveStorePathMock.mockReset().mockReturnValue("/tmp/session-store.json");
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

  it("splits legacy combined session overrides when providerOverride is missing", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
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
      provider: "ollama-beelink2",
      model: "qwen2.5-coder:7b",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("preserves provider when runtime model is a vendor-prefixed OpenRouter id", async () => {
    state.loadSessionStoreMock.mockReturnValue({
      main: {
        modelProvider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
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
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
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
});

// Verifies live session model selection, switch queuing, and pending-flag cleanup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import * as mod from "./live-model-switch.js";

const state = vi.hoisted(() => ({
  resolveDefaultModelForAgentMock: vi.fn(),
  resolvePersistedSelectedModelRefMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
}));

vi.mock("./model-selection.js", async () => {
  const actual =
    await vi.importActual<typeof import("./model-selection.js")>("./model-selection.js");
  return {
    normalizeStoredOverrideModel: actual.normalizeStoredOverrideModel,
    resolveDefaultModelForAgent: (...args: unknown[]) =>
      state.resolveDefaultModelForAgentMock(...args),
    resolvePersistedSelectedModelRef: (...args: unknown[]) =>
      state.resolvePersistedSelectedModelRefMock(...args),
  };
});

// mock-isolation: Model-selection cases use an in-memory store without opening SQLite writers.
vi.mock("../config/sessions/session-accessor.js", () => {
  return {
    patchSessionEntryCore: (...args: unknown[]) => state.updateSessionStoreMock(...args),
  };
});

// mock-isolation: These policy cases supply persisted selections without starting read workers.
vi.mock("../config/sessions/session-entry-read-runtime.js", () => ({
  readSessionEntryReadOnlyInWorker: async (scope: { sessionKey: string }) => {
    const store = state.loadSessionStoreMock(scope) as Record<string, unknown> | undefined;
    return store?.[scope.sessionKey];
  },
}));

vi.mock("../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: (...args: unknown[]) => state.resolveStorePathMock(...args),
}));

async function loadModule() {
  return mod;
}

type ShouldSwitchParams = Parameters<
  typeof import("./live-model-switch.js").shouldSwitchToLiveModel
>[0];

function makeShouldSwitchParams(overrides: Partial<ShouldSwitchParams> = {}): ShouldSwitchParams {
  // Defaults model an active Anthropic run so individual tests can override
  // only the persisted/live selection fields under scrutiny.
  return {
    cfg: { session: { store: "/tmp/custom-store.json" } },
    sessionKey: "main",
    agentId: "reply",
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-6",
    currentProvider: "anthropic",
    currentModel: "claude-opus-4-6",
    ...overrides,
  };
}

function resolvePendingSelection(
  entry: Record<string, unknown>,
  overrides: Partial<ShouldSwitchParams> = {},
) {
  state.loadSessionStoreMock.mockReturnValue({
    main: { liveModelSwitchPending: true, ...entry },
  });
  return mod.shouldSwitchToLiveModel(makeShouldSwitchParams(overrides));
}

describe("live model switch", () => {
  beforeEach(() => {
    state.resolveDefaultModelForAgentMock
      .mockReset()
      .mockReturnValue({ provider: "anthropic", model: "claude-opus-4-6" });
    state.resolvePersistedSelectedModelRefMock
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
          const overrideProvider = params.overrideProvider?.trim();
          const overrideModel = params.overrideModel?.trim();
          if (overrideModel) {
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
          }
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
          return null;
        },
      );
    state.loadSessionStoreMock.mockReset().mockReturnValue({});
    state.resolveStorePathMock.mockReset().mockReturnValue("/tmp/session-store.json");
    state.updateSessionStoreMock
      .mockReset()
      .mockImplementation(
        async (
          scope: { sessionKey: string },
          updater: (
            entry: Record<string, unknown>,
          ) => Promise<Record<string, unknown> | null> | Record<string, unknown> | null,
        ) => {
          const store = state.loadSessionStoreMock(scope) as Record<
            string,
            Record<string, unknown>
          >;
          const entry = store?.[scope.sessionKey];
          if (!entry) {
            return null;
          }
          const next = await updater(entry);
          if (!next) {
            return entry;
          }
          for (const key of Object.keys(entry)) {
            delete entry[key];
          }
          Object.assign(entry, next);
          return entry;
        },
      );
  });

  it("strips duplicated provider prefixes from persisted overrides", async () => {
    expect(
      await resolvePendingSelection({
        providerOverride: "openai",
        modelOverride: "openai/gpt-5.4",
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.4",
      authProfileId: undefined,
      authProfileIdSource: undefined,
    });
  });

  it("treats auth-profile-source changes as no-op when no auth profile is selected", async () => {
    expect(
      await resolvePendingSelection(
        { providerOverride: "openai", modelOverride: "gpt-5.4" },
        {
          currentProvider: "openai",
          currentModel: "gpt-5.4",
          currentAuthProfileIdSource: "auto",
        },
      ),
    ).toBeUndefined();
  });

  describe("shouldSwitchToLiveModel", () => {
    it("returns undefined when liveModelSwitchPending is false", async () => {
      state.loadSessionStoreMock.mockReturnValue({
        main: {
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
        },
      });

      const { shouldSwitchToLiveModel } = await loadModule();

      const result = await shouldSwitchToLiveModel(makeShouldSwitchParams());

      expect(result).toBeUndefined();
      expect(state.loadSessionStoreMock).toHaveBeenCalledWith({
        hydrateSkillPromptRefs: false,
        clone: false,
        readConsistency: "latest",
        sessionKey: "main",
        storePath: "/tmp/session-store.json",
      });
    });

    it("returns undefined when sessionKey is missing", async () => {
      const { shouldSwitchToLiveModel } = await loadModule();

      const result = await shouldSwitchToLiveModel(
        makeShouldSwitchParams({ sessionKey: undefined }),
      );

      expect(result).toBeUndefined();
    });
  });

  describe("prepareLiveModelSwitchAfterRun", () => {
    const completionParams = {
      cfg: { session: { store: "/tmp/custom-store.json" } },
      sessionKey: "main",
      agentId: "reply",
    };

    it.each<{
      name: string;
      entry: Partial<SessionEntry>;
      providerUsed: string;
      modelUsed: string;
      clears: boolean;
    }>([
      {
        name: "different model",
        entry: { providerOverride: "openai", modelOverride: "gpt-5.5" },
        providerUsed: "anthropic",
        modelUsed: "claude-opus-4-6",
        clears: false,
      },
      {
        name: "already consumed flag",
        entry: {
          liveModelSwitchPending: undefined,
          providerOverride: "openai",
          modelOverride: "gpt-5.5",
        },
        providerUsed: "openai",
        modelUsed: "gpt-5.5",
        clears: false,
      },
    ])(
      "prepares terminal cleanup for $name without mutating its snapshot",
      ({ entry, providerUsed, modelUsed, clears }) => {
        const snapshot: SessionEntry = {
          sessionId: "session",
          updatedAt: 1,
          liveModelSwitchPending: true,
          ...entry,
        };
        const before = structuredClone(snapshot);
        const reducer = mod.prepareLiveModelSwitchAfterRun({
          ...completionParams,
          entry: snapshot,
          providerUsed,
          modelUsed,
        });
        expect(Boolean(reducer?.clearPending)).toBe(clears);
        expect(snapshot).toEqual(before);
        expect(state.updateSessionStoreMock).not.toHaveBeenCalled();
      },
    );

    it("resolves the owning agent's default from the session key", () => {
      const reducer = mod.prepareLiveModelSwitchAfterRun({
        cfg: completionParams.cfg,
        sessionKey: "agent:owner:main",
        entry: { sessionId: "session", updatedAt: 1, liveModelSwitchPending: true },
        providerUsed: "anthropic",
        modelUsed: "claude-opus-4-6",
      });
      expect(reducer?.clearPending).toBe(true);
      expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalledWith({
        cfg: completionParams.cfg,
        agentId: "owner",
      });
      expect(state.resolveStorePathMock).not.toHaveBeenCalled();
    });
  });

  describe.each(["already-applied", "accepted"] as const)(
    "queued live-model clear after %s selection",
    (mode) => {
      it.each([
        { field: "provider", newer: { providerOverride: "other-provider" } },
        { field: "model", newer: { modelOverride: "gpt-5.5" } },
        { field: "runtime", newer: { agentRuntimeOverride: "codex" } },
        { field: "auth profile", newer: { authProfileOverride: "profile-b" } },
        { field: "auth source", newer: { authProfileOverrideSource: "auto" } },
      ])("preserves a newer $field request", async ({ newer }) => {
        const sessionEntry = {
          liveModelSwitchPending: true,
          providerOverride: "openai",
          modelOverride: "gpt-5.4",
          agentRuntimeOverride: "openclaw",
          authProfileOverride: "profile-a",
          authProfileOverrideSource: "user",
        };
        state.loadSessionStoreMock.mockReturnValue({ main: sessionEntry });
        const applyPatch = state.updateSessionStoreMock.getMockImplementation();
        if (!applyPatch) {
          throw new Error("Session patch fixture is unavailable");
        }
        const gate = createDeferredCore();
        state.updateSessionStoreMock.mockImplementationOnce(async (...args: unknown[]) => {
          // The real writer queue reads its row only after earlier writes settle.
          await gate.promise;
          return applyPatch(...args);
        });
        const params = makeShouldSwitchParams({
          currentProvider: "openai",
          currentModel: mode === "accepted" ? "gpt-5.5" : "gpt-5.4",
          currentAgentRuntimeOverride: "openclaw",
          currentAuthProfileId: "profile-a",
          currentAuthProfileIdSource: "user",
        });
        let pendingClear: Promise<void> | undefined;
        try {
          const selection = await mod.shouldSwitchToLiveModel(params);
          if (mode === "accepted") {
            if (!selection) {
              throw new Error("Expected a pending live model selection");
            }
            pendingClear = mod.clearLiveModelSwitchPending({
              cfg: params.cfg,
              sessionKey: params.sessionKey,
              agentId: params.agentId,
              defaultProvider: params.defaultProvider,
              defaultModel: params.defaultModel,
              expectedSelection: selection,
            });
          } else {
            expect(selection).toBeUndefined();
          }
          expect(state.updateSessionStoreMock).toHaveBeenCalledTimes(1);
          Object.assign(sessionEntry, newer);
        } finally {
          gate.resolve();
          await (pendingClear ?? state.updateSessionStoreMock.mock.results[0]?.value);
        }
        expect(sessionEntry).toMatchObject({ liveModelSwitchPending: true, ...newer });
      });
    },
  );

  describe("clearLiveModelSwitchPending", () => {
    it("is a no-op when sessionKey is missing", async () => {
      const { clearLiveModelSwitchPending } = await loadModule();

      await clearLiveModelSwitchPending({
        cfg: { session: { store: "/tmp/custom-store.json" } },
        sessionKey: undefined,
        agentId: "reply",
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-6",
        expectedSelection: { provider: "anthropic", model: "claude-opus-4-6" },
      });

      expect(state.updateSessionStoreMock).not.toHaveBeenCalled();
    });
  });
});

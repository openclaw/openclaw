import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("../config/sessions/session-accessor.js", () => ({
  patchSessionEntryCore: (...args: unknown[]) => state.updateSessionStoreMock(...args),
}));

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

const { resolvePersistedSelectedModelRef } =
  await vi.importActual<typeof import("./model-selection.js")>("./model-selection.js");

type ShouldSwitchParams = Parameters<typeof mod.shouldSwitchToLiveModel>[0];
const defaultModel = { provider: "anthropic", model: "claude-opus-4-6" };
const completionParams = {
  cfg: { session: { store: "/tmp/custom-store.json" } },
  sessionKey: "main",
  agentId: "reply",
};

function makeShouldSwitchParams(overrides: Partial<ShouldSwitchParams> = {}): ShouldSwitchParams {
  return {
    ...completionParams,
    defaultProvider: defaultModel.provider,
    defaultModel: defaultModel.model,
    currentProvider: defaultModel.provider,
    currentModel: defaultModel.model,
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

beforeEach(() => {
  state.resolveDefaultModelForAgentMock.mockReset().mockReturnValue(defaultModel);
  state.resolvePersistedSelectedModelRefMock
    .mockReset()
    .mockImplementation((params: Parameters<typeof resolvePersistedSelectedModelRef>[0]) =>
      resolvePersistedSelectedModelRef({
        ...params,
        allowManifestNormalization: false,
        allowPluginNormalization: false,
      }),
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
        const store: Record<string, Record<string, unknown>> = state.loadSessionStoreMock(scope);
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

it("returns undefined when sessionKey is missing", async () => {
  expect(
    await mod.shouldSwitchToLiveModel(makeShouldSwitchParams({ sessionKey: undefined })),
  ).toBeUndefined();
});
it("resolves the owning agent's default from the session key", () => {
  const reducer = mod.prepareLiveModelSwitchAfterRun({
    cfg: completionParams.cfg,
    sessionKey: "agent:owner:main",
    entry: { sessionId: "session", updatedAt: 1, liveModelSwitchPending: true },
    providerUsed: defaultModel.provider,
    modelUsed: defaultModel.model,
  });
  expect(reducer?.clearPending).toBe(true);
  expect(state.resolveDefaultModelForAgentMock).toHaveBeenCalledWith({
    cfg: completionParams.cfg,
    agentId: "owner",
  });
  expect(state.resolveStorePathMock).not.toHaveBeenCalled();
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
            ...params,
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

it("clearLiveModelSwitchPending is a no-op when sessionKey is missing", async () => {
  await mod.clearLiveModelSwitchPending({
    ...makeShouldSwitchParams(),
    sessionKey: undefined,
    expectedSelection: defaultModel,
  });
  expect(state.updateSessionStoreMock).not.toHaveBeenCalled();
});

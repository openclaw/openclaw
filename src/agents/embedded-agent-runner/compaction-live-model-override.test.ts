// Regression coverage for #95696: a mid-session `/model` switch persisted to
// the session store must drive the compaction target, not the stale run-start
// provider/model. Exercises the real composition the run loop uses at its
// auto-compaction sites: shouldSwitchToLiveModel(...) -> requestedSelection ->
// buildEmbeddedCompactionRuntimeContext({ provider, modelId }). The session
// store I/O and the registry-validating model ref resolver are mocked at the
// same boundary as live-model-switch.test.ts; the switch gating and the
// compaction-context builder run for real.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  resolveDefaultModelForAgentMock: vi.fn(),
  resolvePersistedSelectedModelRefMock: vi.fn(),
  loadSessionStoreMock: vi.fn(),
  resolveStorePathMock: vi.fn(),
  updateSessionStoreMock: vi.fn(),
}));

vi.mock("../model-selection.js", async () => {
  const actual =
    await vi.importActual<typeof import("../model-selection.js")>("../model-selection.js");
  return {
    normalizeStoredOverrideModel: actual.normalizeStoredOverrideModel,
    resolveDefaultModelForAgent: (...args: unknown[]) =>
      state.resolveDefaultModelForAgentMock(...args),
    resolvePersistedSelectedModelRef: (...args: unknown[]) =>
      state.resolvePersistedSelectedModelRefMock(...args),
  };
});

vi.mock("../../config/sessions/store.js", () => ({
  loadSessionStore: (...args: unknown[]) => state.loadSessionStoreMock(...args),
  updateSessionStore: (...args: unknown[]) => state.updateSessionStoreMock(...args),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: (...args: unknown[]) => state.resolveStorePathMock(...args),
}));

import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { shouldSwitchToLiveModel } from "../live-model-switch.js";
import { buildEmbeddedCompactionRuntimeContext } from "./compaction-runtime-context.js";

const CFG = { session: { store: "/tmp/store.json" } };
const SESSION_KEY = "sess-1";
const RUN_START_PROVIDER = "anthropic";
const RUN_START_MODEL = "sonnet-4.6";

// Mirror the run loop's auto-compaction wiring (run.ts): reuse the live-switch
// selection as the compaction provider/model/auth profile, falling back to the
// run-start values when no switch is pending, and dropping a run-start auth
// profile that belongs to a different provider after a cross-provider switch.
function buildCompactionTarget(lastProfileId?: string) {
  const requestedSelection = shouldSwitchToLiveModel({
    cfg: CFG,
    sessionKey: SESSION_KEY,
    defaultProvider: RUN_START_PROVIDER,
    defaultModel: RUN_START_MODEL,
    currentProvider: RUN_START_PROVIDER,
    currentModel: RUN_START_MODEL,
  });
  const compactionProvider = requestedSelection?.provider ?? RUN_START_PROVIDER;
  const compactionModelId = requestedSelection?.model ?? RUN_START_MODEL;
  const compactionAuthProfileId =
    requestedSelection == null
      ? lastProfileId
      : (requestedSelection.authProfileId ??
        (normalizeProviderId(requestedSelection.provider) ===
        normalizeProviderId(RUN_START_PROVIDER)
          ? lastProfileId
          : undefined));
  return buildEmbeddedCompactionRuntimeContext({
    sessionKey: SESSION_KEY,
    workspaceDir: "/tmp/ws",
    agentDir: "/tmp/agent",
    provider: compactionProvider,
    modelId: compactionModelId,
    authProfileId: compactionAuthProfileId,
  });
}

describe("compaction respects the live session model override (#95696)", () => {
  beforeEach(() => {
    state.loadSessionStoreMock.mockReset();
    state.resolveStorePathMock.mockReset().mockReturnValue("/tmp/store.json");
    state.resolvePersistedSelectedModelRefMock
      .mockReset()
      .mockImplementation((params: { overrideProvider?: string; overrideModel?: string }) =>
        params.overrideProvider && params.overrideModel
          ? { provider: params.overrideProvider, model: params.overrideModel }
          : null,
      );
  });

  it("targets the switched model after a persisted /model override", () => {
    state.loadSessionStoreMock.mockReturnValue({
      [SESSION_KEY]: {
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      },
    });

    const ctx = buildCompactionTarget();

    expect(ctx.provider).toBe("openai");
    expect(ctx.model).toBe("gpt-5.5");
  });

  it("keeps the run-start model and auth profile when no override is persisted", () => {
    state.loadSessionStoreMock.mockReturnValue({});

    const ctx = buildCompactionTarget("anthropic:default");

    expect(ctx.provider).toBe(RUN_START_PROVIDER);
    expect(ctx.model).toBe(RUN_START_MODEL);
    expect(ctx.authProfileId).toBe("anthropic:default");
  });

  it("uses the switch-pinned auth profile after a cross-provider override", () => {
    state.loadSessionStoreMock.mockReturnValue({
      [SESSION_KEY]: {
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        authProfileOverride: "openai:p1",
      },
    });

    const ctx = buildCompactionTarget("anthropic:default");

    expect(ctx.provider).toBe("openai");
    expect(ctx.authProfileId).toBe("openai:p1");
  });

  it("drops the stale run-start profile when a cross-provider switch pins none", () => {
    // The run-start profile authenticates the old provider; pairing it with the
    // newly selected provider would send the wrong credentials (#95696).
    state.loadSessionStoreMock.mockReturnValue({
      [SESSION_KEY]: {
        liveModelSwitchPending: true,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
      },
    });

    const ctx = buildCompactionTarget("anthropic:default");

    expect(ctx.provider).toBe("openai");
    expect(ctx.authProfileId).not.toBe("anthropic:default");
  });
});

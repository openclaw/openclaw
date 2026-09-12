import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  TURN_MODEL_DEFAULT_REF,
  TURN_MODEL_DIFFERENTIAL_FIXTURES,
  TURN_MODEL_OVERRIDE_REF,
  turnModelRefLabel,
  turnModelVerdict,
  type TurnModelDifferentialFixture,
} from "../../test-utils/turn-model-selection-differential.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import type { AgentCommandOpts, AgentRunContext } from "./types.js";

vi.mock("../agent-scope.js", async () => {
  const { resolveSessionAgentIds } =
    await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
  return {
    clearAutoFallbackPrimaryProbeSelection: vi.fn(),
    hasLegacyAutoFallbackWithoutOrigin: () => false,
    hasSessionAutoModelFallbackProvenance: () => false,
    resolveAutoFallbackPrimaryProbe: () => undefined,
    resolveAgentConfig: () => undefined,
    resolveAgentEffectiveModelPrimary: () => undefined,
    resolveAgentModelFallbacksOverride: () => undefined,
    resolveSessionAgentIds,
  };
});
vi.mock("../../auto-reply/thinking.js", () => ({
  formatThinkingLevels: () => "",
  isThinkingLevelSupported: () => true,
  normalizeThinkLevel: (value: string | undefined) => value,
}));
vi.mock("../../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: (params: {
    cfg: OpenClawConfig;
    channel?: string | null;
    groupId?: string | null;
    groupChatType?: string | null;
    groupChannel?: string | null;
    groupSubject?: string | null;
    directUserIds?: (string | null | undefined)[];
  }) => {
    const channel = params.channel?.trim().toLowerCase();
    const entries = channel ? params.cfg.channels?.modelByChannel?.[channel] : undefined;
    if (!channel || !entries) {
      return null;
    }
    const candidates =
      params.groupChatType === "direct"
        ? [params.groupId, ...(params.directUserIds ?? [])]
        : [params.groupId, params.groupChannel, params.groupSubject];
    const matchKey = candidates.find((candidate) => candidate && entries[candidate] !== undefined);
    const wildcard = entries["*"];
    const model = matchKey ? entries[matchKey] : wildcard;
    return model
      ? { channel, model, matchKey: matchKey ?? "*", matchSource: matchKey ? "exact" : "wildcard" }
      : null;
  },
}));
vi.mock("../../utils/message-channel.js", () => ({
  isDeliverableMessageChannel: (value: string) => value !== "internal",
}));

vi.mock("../auth-profiles/order.js", () => ({
  isStoredCredentialCompatibleWithAuthProvider: () => true,
}));
vi.mock("../auth-profiles/session-override.js", () => ({
  clearSessionAuthProfileOverride: vi.fn(async () => undefined),
}));
vi.mock("../auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
}));
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
vi.mock("../harness/selection.js", () => ({
  resolveAvailableAgentHarnessPolicy: () => ({ runtime: "openclaw" }),
}));
vi.mock("../prepared-model-catalog.js", () => ({
  loadPreparedModelCatalogSnapshot: vi.fn(async () => {
    const entries = [
      { provider: "fixture", id: "parent", name: "Parent" },
      { provider: "fixture", id: "child", name: "Child" },
      { provider: DEFAULT_PROVIDER, id: DEFAULT_MODEL, name: "Default" },
      {
        provider: TURN_MODEL_DEFAULT_REF.provider,
        id: TURN_MODEL_DEFAULT_REF.model,
        name: "Command default",
      },
    ];
    return { entries, routeVariants: entries };
  }),
}));
vi.mock("../model-selection.js", () => ({
  modelKey: (provider: string, model: string) => `${provider}/${model}`,
  resolveDefaultModelForAgent: ({ cfg }: { cfg: OpenClawConfig }) => {
    const configured = cfg.agents?.defaults?.model;
    const raw =
      typeof configured === "string"
        ? configured
        : (configured?.primary ?? turnModelRefLabel(TURN_MODEL_DEFAULT_REF));
    const slash = raw.indexOf("/");
    return slash > 0
      ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
      : { provider: TURN_MODEL_DEFAULT_REF.provider, model: raw };
  },
  resolveModelAliasFromPair: () => null,
  resolveThinkingDefault: () => "off",
}));
vi.mock("../model-thinking-default.js", () => ({
  resolveConfiguredThinkingDefault: () => undefined,
}));
vi.mock("../model-visibility-policy.js", () => ({
  createModelVisibilityPolicy: ({
    defaultProvider,
    defaultModel,
  }: {
    defaultProvider: string;
    defaultModel: string;
  }) => ({
    effectiveDefault: { ref: { provider: defaultProvider, model: defaultModel } },
    allowAny: true,
    allowedCatalog: [],
    selectionAliasIndex: { byAlias: new Map(), byKey: new Map() },
    allows: () => true,
    resolveSelection: (ref: { provider: string; model: string }) => ref,
  }),
}));
vi.mock("../provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) => provider,
}));
vi.mock("../session-runtime-compat.js", () => ({
  resolveSessionRuntimeOverrideForProvider: () => undefined,
}));
vi.mock("../thinking-runtime.js", () => ({
  hasResolvedThinkingCatalogEntry: () => false,
  normalizeThinkingCatalogProviders: (catalog: unknown) => catalog,
  resolveEffectiveAgentRuntime: () => undefined,
}));
vi.mock("../../plugins/runtime.js", () => ({ requireActivePluginRegistry: () => ({}) }));
vi.mock("../../sessions/agent-harness-session-key.js", () => ({
  isValidAgentHarnessSessionStoreEntry: () => false,
}));
vi.mock("../../sessions/model-overrides.js", async () => ({
  createConfiguredPrimarySessionEntry: (
    await vi.importActual<typeof import("../../sessions/model-overrides.js")>(
      "../../sessions/model-overrides.js",
    )
  ).createConfiguredPrimarySessionEntry,
  applyModelOverrideToSessionEntry: () => ({ updated: false }),
  isModelSelectionLocked: (entry?: SessionEntry) => entry?.modelSelectionLocked === true,
  ModelSelectionLockedError: class ModelSelectionLockedError extends Error {},
  repairProviderWrappedModelOverride: () => ({ updated: false }),
}));
vi.mock("./attempt-execution.shared.js", () => ({
  persistAgentSession: async ({ entry }: { entry?: SessionEntry }) => entry,
}));
vi.mock("./model-ref.js", () => ({
  normalizeAgentCommandDefaultModelRef: (
    _cfg: OpenClawConfig,
    provider: string,
    model: string,
  ) => ({ provider, model }),
  normalizeAgentCommandModelRef: (_cfg: OpenClawConfig, provider: string, model: string) => ({
    provider,
    model,
  }),
  parseAgentCommandModelRef: (
    _cfg: OpenClawConfig,
    _agentId: string,
    raw: string,
    defaultProvider: string,
  ) => {
    const slash = raw.indexOf("/");
    return slash > 0
      ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
      : { provider: defaultProvider, model: raw };
  },
}));
vi.mock("./prepare.js", () => ({
  normalizeExplicitOverrideInput: (value: string) => value.trim() || undefined,
}));
vi.mock("./runtime-loaders.js", () => ({
  loadTranscriptResolveRuntime: async () => ({
    resolveSessionTranscriptFile: async (params: { sessionEntry?: SessionEntry }) => ({
      sessionEntry: params.sessionEntry,
      sessionFile: "/tmp/turn-model-session.jsonl",
    }),
  }),
}));

const { resolveEmbeddedModelSelection } = await import("./model-selection.js");

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
let suiteTempRoot = "";

beforeAll(() => {
  suiteTempRoot = tempDirs.make("turn-model-command-");
});

function createConfig(fixture: TurnModelDifferentialFixture): OpenClawConfig {
  return {
    agents: { defaults: { model: { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) } } },
    channels: fixture.modelByChannel ? { modelByChannel: fixture.modelByChannel } : undefined,
  } as OpenClawConfig;
}

async function observeCommandSelection(fixture: TurnModelDifferentialFixture) {
  const fixtureIndex = TURN_MODEL_DIFFERENTIAL_FIXTURES.indexOf(fixture);
  const sessionKey = "agent:main:telegram:group:selection";
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: fixture.child };
  if (fixture.parent) {
    sessionStore[fixture.parent.key] = fixture.parent.entry;
  }
  const opts: AgentCommandOpts = {
    message: "hello",
    to: "target",
    channel: fixture.ctx.Provider,
    messageChannel: fixture.ctx.Provider,
    groupId: fixture.child.groupId,
    groupChannel: fixture.child.groupChannel,
    ...(fixture.heartbeat
      ? {
          provider: TURN_MODEL_OVERRIDE_REF.provider,
          model: TURN_MODEL_OVERRIDE_REF.model,
          allowModelOverride: true,
        }
      : {}),
  };
  const runContext: AgentRunContext = {
    messageChannel: fixture.ctx.Provider,
    groupId: fixture.child.groupId,
    groupChannel: fixture.child.groupChannel,
    currentChannelId: "target",
  };
  const selection = await resolveEmbeddedModelSelection({
    cfg: createConfig(fixture),
    opts,
    sessionEntry: fixture.child,
    sessionStore,
    sessionKey,
    sessionId: fixture.child.sessionId,
    storePath: path.join(suiteTempRoot, `sessions-${fixtureIndex}.json`),
    sessionAgentId: "main",
    workspaceDir: suiteTempRoot,
    pluginsEnabled: false,
    modelManifestContext: {},
    configuredThinkingCatalog: [],
    isSubagentLane: false,
    suppressVisibleSessionEffects: true,
    runContext,
  });
  return turnModelVerdict(
    { provider: selection.provider, model: selection.model },
    fixture.locked ? "locked" : fixture.heartbeat ? "explicit" : undefined,
  );
}

describe("turn model selection command-path differential", () => {
  it.each([
    { sessionKey: "agent:main:main", mode: "inherit", model: "parent" },
    { sessionKey: "agent:main:subagent:child", mode: "inherit", model: "child" },
    { sessionKey: "agent:main:subagent:child", mode: "stored", model: "child" },
    { sessionKey: "agent:main:main", mode: "request", model: "child" },
    { sessionKey: "agent:main:main", mode: "denied", model: "parent" },
    { sessionKey: "agent:main:main", mode: "denied-durable", model: "parent" },
    { sessionKey: "agent:main:main", mode: "inherited-denied", model: "parent" },
    { sessionKey: "agent:main:main", mode: "no-primary", model: "child" },
    { sessionKey: "agent:main:main", mode: "one-turn", model: "parent" },
    { sessionKey: "agent:main:main", mode: "locked", model: "child" },
  ])(
    "uses only the configured primary for $sessionKey ($mode)",
    async ({ sessionKey, mode, model }) => {
      const defaults = await import("../model-selection-config.js");
      const policy = await vi.importActual<typeof import("../model-visibility-policy.js")>(
        "../model-visibility-policy.js",
      );
      const defaultSpy = vi
        .spyOn(await import("../model-selection.js"), "resolveDefaultModelForAgent")
        .mockImplementation(defaults.resolveDefaultModelForAgent);
      const policySpy = vi
        .spyOn(await import("../model-visibility-policy.js"), "createModelVisibilityPolicy")
        .mockImplementation(policy.createModelVisibilityPolicy);
      const overrides = await vi.importActual<typeof import("../../sessions/model-overrides.js")>(
        "../../sessions/model-overrides.js",
      );
      const overrideSpy = vi
        .spyOn(
          await import("../../sessions/model-overrides.js"),
          "applyModelOverrideToSessionEntry",
        )
        .mockImplementation(overrides.applyModelOverrideToSessionEntry);
      const persistSpy = vi.spyOn(
        await import("./attempt-execution.shared.js"),
        "persistAgentSession",
      );
      const cfg: OpenClawConfig = {
        agents: {
          entries: { main: {} },
          defaults: {
            ...(mode !== "no-primary" ? { model: "fixture/parent@parent-profile" } : {}),
            subagents: { model: "fixture/child@child-profile" },
            modelPolicy: { allow: ["fixture/parent"] },
          },
        },
      };
      const entry: SessionEntry = {
        sessionId: "scoped-primary",
        updatedAt: 1,
        ...(["stored", "denied", "denied-durable", "no-primary", "one-turn", "locked"].includes(
          mode,
        )
          ? {
              providerOverride: "fixture",
              modelOverride: "child",
              modelOverrideSource: "user" as const,
            }
          : {}),
        ...(["denied", "denied-durable"].includes(mode)
          ? {
              agentRuntimeOverride: "fixture-runtime",
              authProfileOverride: "child-profile",
              authProfileOverrideSource: "user" as const,
              modelProvider: "fixture",
              model: "child",
            }
          : {}),
        ...(mode === "locked"
          ? { modelSelectionLocked: true, agentHarnessId: "turn-model-recorder" }
          : {}),
        ...(mode === "inherited-denied" ? { parentSessionKey: "agent:main:parent" } : {}),
      };
      const sessionStore: Record<string, SessionEntry> = { [sessionKey]: entry };
      if (mode === "inherited-denied") {
        sessionStore["agent:main:parent"] = {
          sessionId: "parent",
          updatedAt: 1,
          providerOverride: "fixture",
          modelOverride: "child",
        };
      }
      const original = structuredClone(sessionStore);
      try {
        const selection = resolveEmbeddedModelSelection({
          cfg,
          opts: {
            message: "hello",
            ...(mode === "request" || mode === "one-turn"
              ? { model: `fixture/${model}`, allowModelOverride: true }
              : {}),
          },
          sessionEntry: entry,
          sessionStore,
          sessionKey,
          sessionId: entry.sessionId,
          storePath: path.join(suiteTempRoot, "scoped-primary.json"),
          sessionAgentId: "main",
          workspaceDir: suiteTempRoot,
          pluginsEnabled: false,
          modelManifestContext: { manifestPlugins: [] },
          configuredThinkingCatalog: [],
          isSubagentLane: sessionKey !== "agent:main:main",
          suppressVisibleSessionEffects: mode !== "denied-durable",
          runContext: { currentChannelId: "target" },
        });
        if (mode === "request") {
          await expect(selection).rejects.toThrow("not allowed");
        } else if (mode === "no-primary") {
          await expect(selection).resolves.toMatchObject({
            provider: "fixture",
            model: "parent",
            configuredDefaultAuthProfileId: undefined,
            allowListPolicyFallback: {
              pinnedModel: "fixture/child",
              primaryModel: "fixture/parent",
            },
          });
        } else {
          await expect(selection).resolves.toMatchObject({
            provider: "fixture",
            model,
            configuredDefaultAuthProfileId: `${sessionKey === "agent:main:main" ? "parent" : "child"}-profile`,
          });
          const resolved = await selection;
          if (["denied", "denied-durable", "inherited-denied"].includes(mode)) {
            expect(resolved.allowListPolicyFallback).toEqual({
              pinnedModel: "fixture/child",
              primaryModel: "fixture/parent",
            });
            expect(resolved.sessionEntryForAttempt?.modelOverride).toBeUndefined();
            expect(resolved.sessionEntryForAttempt?.authProfileOverride).toBeUndefined();
            expect(resolved.sessionEntryForAttempt?.agentRuntimeOverride).toBeUndefined();
          } else {
            expect(resolved.allowListPolicyFallback).toBeUndefined();
          }
        }
        expect(sessionStore).toEqual(original);
        expect(persistSpy).not.toHaveBeenCalled();
      } finally {
        defaultSpy.mockRestore();
        policySpy.mockRestore();
        overrideSpy.mockRestore();
        persistSpy.mockRestore();
      }
    },
  );

  it.each(TURN_MODEL_DIFFERENTIAL_FIXTURES)("pins observed $name behavior", async (fixture) => {
    await expect(observeCommandSelection(fixture)).resolves.toEqual(fixture.expected.command);
  });
});

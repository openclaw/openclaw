import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
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

const { parseRef } = vi.hoisted(() => ({
  parseRef: (raw: string, defaultProvider: string) => {
    const slash = raw.indexOf("/");
    return slash > 0
      ? { provider: raw.slice(0, slash), model: raw.slice(slash + 1) }
      : { provider: defaultProvider, model: raw };
  },
}));

vi.mock("../agent-scope.js", () => ({
  clearAutoFallbackPrimaryProbeSelection: vi.fn(),
  hasLegacyAutoFallbackWithoutOrigin: () => false,
  hasSessionAutoModelFallbackProvenance: () => false,
  resolveAutoFallbackPrimaryProbe: () => undefined,
  resolveAgentConfig: () => undefined,
  resolveNativeModelPrimary: () => undefined,
}));
vi.mock("../../channels/model-overrides.js", () => ({
  resolveChannelModelOverride: (
    params: Parameters<
      typeof import("../../channels/model-overrides.js").resolveChannelModelOverride
    >[0],
  ) => {
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

// mock-isolation: Selection fixtures have no auth profiles and must not discover host accounts.
vi.mock("../auth-profiles/store-runtime.js", () => ({
  ensureAuthProfileStore: () => ({ profiles: {} }),
  ensureAuthProfileStoreAsync: () => ({ profiles: {} }),
}));
vi.mock("../harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: vi.fn(async () => undefined),
}));
vi.mock("../model-selection.js", () => ({
  modelKey: (provider: string, model: string) => `${provider}/${model}`,
  resolveDefaultModelForAgent: ({ cfg }: { cfg: OpenClawConfig }) => {
    const configured = cfg.agents?.defaults?.model;
    const raw =
      typeof configured === "string"
        ? configured
        : (configured?.primary ?? turnModelRefLabel(TURN_MODEL_DEFAULT_REF));
    return parseRef(raw, TURN_MODEL_DEFAULT_REF.provider);
  },
  resolveModelAliasFromPair: () => null,
}));
vi.mock("../model-thinking-default.js", () => ({
  resolveConfiguredThinkingDefault: () => undefined,
  resolveThinkingSelection: () => ({ requestedLevel: "off", level: "off", supported: true }),
}));
vi.mock("../model-visibility-policy.js", () => ({
  createModelVisibilityPolicy: () => ({
    allowAny: true,
    catalog: [],
    allowedCatalog: [],
    selectionAliasIndex: { byAlias: new Map(), byKey: new Map() },
    allows: () => true,
    resolveSelection: (ref: { provider: string; model: string }) => ref,
  }),
}));
vi.mock("../session-runtime-compat.js", () => ({
  resolveSessionRuntimeOverrideForProvider: () => undefined,
}));
vi.mock("../thinking-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../thinking-runtime.js")>();
  return {
    ...actual,
    resolveEffectiveAgentRuntime: () => undefined,
  };
});
vi.mock("../../plugins/runtime.js", () => ({ requireActivePluginRegistry: () => ({}) }));
vi.mock("./model-ref.js", () => ({
  normalizeExplicitOverrideInput: (value: string) => value.trim() || undefined,
  normalizeAgentCommandModelRef: (_cfg: OpenClawConfig, provider: string, model: string) => ({
    provider,
    model,
  }),
  parseAgentCommandModelRef: (
    _cfg: OpenClawConfig,
    _agentId: string,
    raw: string,
    defaultProvider: string,
  ) => parseRef(raw, defaultProvider),
}));

const { resolveEmbeddedModelSelection } = await import("./model-selection.js");

const tempDirs = useAutoCleanupTempDirTracker(afterAll);

async function observeCommandSelection(fixture: TurnModelDifferentialFixture) {
  const workspaceDir = tempDirs.make("turn-model-command-");
  const sessionKey = "agent:main:telegram:group:selection";
  const sessionStore: Record<string, SessionEntry> = { [sessionKey]: fixture.child };
  if (fixture.parent) {
    sessionStore[fixture.parent.key] = fixture.parent.entry;
  }
  const routing = {
    messageChannel: fixture.ctx.Provider,
    groupId: fixture.child.groupId,
    groupChannel: fixture.child.groupChannel,
  };
  const selection = await resolveEmbeddedModelSelection({
    cfg: {
      agents: { defaults: { model: { primary: turnModelRefLabel(TURN_MODEL_DEFAULT_REF) } } },
      channels: fixture.modelByChannel ? { modelByChannel: fixture.modelByChannel } : undefined,
    },
    opts: {
      ...routing,
      message: "hello",
      to: "target",
      channel: fixture.ctx.Provider,
      ...(fixture.heartbeat ? { ...TURN_MODEL_OVERRIDE_REF, allowModelOverride: true } : {}),
    },
    sessionEntry: fixture.child,
    sessionStore,
    sessionKey,
    sessionId: fixture.child.sessionId,
    storePath: path.join(workspaceDir, "sessions.json"),
    sessionAgentId: "main",
    workspaceDir,
    pluginsEnabled: false,
    modelManifestContext: {},
    configuredThinkingCatalog: [],
    isSubagentLane: false,
    suppressVisibleSessionEffects: true,
    runContext: { ...routing, currentChannelId: "target" },
  });
  return turnModelVerdict(
    { provider: selection.provider, model: selection.model },
    fixture.locked ? "locked" : fixture.heartbeat ? "explicit" : undefined,
  );
}

it.each(TURN_MODEL_DIFFERENTIAL_FIXTURES)("command-path selection: $name", async (fixture) => {
  await expect(observeCommandSelection(fixture)).resolves.toEqual(fixture.expected.command);
});

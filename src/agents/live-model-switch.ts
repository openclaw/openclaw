/**
 * Resolves and persists live-session model switch requests.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { LiveSessionModelSelection } from "./live-model-switch-error.js";
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";
export {
  LiveSessionModelSwitchError,
  type LiveSessionModelSelection,
} from "./live-model-switch-error.js";

/**
 * Entry-snapshot variant of the selection resolver, so atomic patch callbacks
 * can evaluate the persisted selection against the exact row they may rewrite.
 */
function resolveSelectionFromSessionEntry(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry | undefined;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
}): LiveSessionModelSelection {
  const { cfg, entry } = params;
  const agentId = normalizeOptionalString(params.agentId);
  const defaultModelRef = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
      })
    : { provider: params.defaultProvider, model: params.defaultModel };
  const normalizedSelection = normalizeStoredOverrideModel({
    providerOverride: entry?.providerOverride,
    modelOverride: entry?.modelOverride,
  });
  const persisted = resolvePersistedSelectedModelRef({
    defaultProvider: defaultModelRef.provider,
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: normalizedSelection.providerOverride,
    overrideModel: normalizedSelection.modelOverride,
  });
  const provider =
    persisted?.provider ??
    normalizedSelection.providerOverride ??
    entry?.providerOverride?.trim() ??
    defaultModelRef.provider;
  const model = persisted?.model ?? defaultModelRef.model;
  const agentRuntimeOverride = resolveSessionRuntimeOverrideForProvider({
    provider,
    entry,
    cfg,
  });
  const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
  return {
    provider,
    model,
    ...(agentRuntimeOverride ? { agentRuntimeOverride } : {}),
    authProfileId,
    authProfileIdSource: authProfileId ? resolveCollapsedSessionAuthPinSource(entry) : undefined,
  };
}

function isAlreadyAppliedOpenAICodexRuntimePromotion(
  current: { provider: string; model: string },
  next: LiveSessionModelSelection,
): boolean {
  // The embedded Codex runtime reports openai after applying a canonical
  // openai selection. Other runtime aliases remain real live-switch targets.
  return (
    normalizeProviderId(current.provider) === "openai" &&
    normalizeProviderId(next.provider) === "openai" &&
    current.model === next.model
  );
}

function hasDifferentLiveSessionModelSelection(
  current: Omit<LiveSessionModelSelection, "authProfileIdSource"> & {
    authProfileIdSource?: string;
  },
  next: LiveSessionModelSelection,
): boolean {
  const modelSelectionDiffers =
    (current.provider !== next.provider || current.model !== next.model) &&
    !isAlreadyAppliedOpenAICodexRuntimePromotion(current, next);
  return (
    modelSelectionDiffers ||
    normalizeOptionalString(current.agentRuntimeOverride) !== next.agentRuntimeOverride ||
    normalizeOptionalString(current.authProfileId) !== next.authProfileId ||
    (normalizeOptionalString(current.authProfileId) ? current.authProfileIdSource : undefined) !==
      next.authProfileIdSource
  );
}

/**
 * Return a pending user selection and eagerly clear switches already applied.
 * The runner consumes an unapplied switch only when canRestartForLiveSwitch
 * permits it; otherwise the flag survives tool execution and later user turns.
 */
export async function shouldSwitchToLiveModel(params: {
  cfg?: OpenClawConfig | undefined;
  sessionKey?: string;
  agentId?: string;
  sessionPersistence?: "durable" | "detached";
  defaultProvider: string;
  defaultModel: string;
  currentProvider: string;
  currentModel: string;
  currentAgentRuntimeOverride?: string;
  currentAuthProfileId?: string;
  currentAuthProfileIdSource?: string;
}): Promise<LiveSessionModelSelection | undefined> {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  // A borrowed identity does not own the durable turn's pending switch.
  if (!cfg || !sessionKey || params.sessionPersistence === "detached") {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: params.agentId?.trim(),
  });
  const entry = await readSessionEntryReadOnlyInWorker({
    storePath,
    sessionKey,
    hydrateSkillPromptRefs: false,
    clone: false,
    readConsistency: "latest",
  });
  if (!entry?.liveModelSwitchPending) {
    return undefined;
  }
  const persisted = resolveSelectionFromSessionEntry({
    cfg,
    entry,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (
    !hasDifferentLiveSessionModelSelection(
      {
        provider: params.currentProvider,
        model: params.currentModel,
        agentRuntimeOverride: params.currentAgentRuntimeOverride,
        authProfileId: params.currentAuthProfileId,
        authProfileIdSource: params.currentAuthProfileIdSource,
      },
      persisted,
    )
  ) {
    // Current model already matches the persisted selection — the switch has
    // effectively been applied.  Clear the stale flag so subsequent fallback
    // iterations don't re-evaluate it.
    clearLiveModelSwitchPending({
      cfg,
      sessionKey,
      agentId: params.agentId,
      defaultProvider: params.defaultProvider,
      defaultModel: params.defaultModel,
      expectedSelection: persisted,
    }).catch(() => {
      /* best-effort — fs/lock errors are non-fatal here */
    });
    return undefined;
  }
  return persisted;
}

/**
 * Completed runs, including CLI harness runs, consume their applied switch
 * regardless of runtime/auth drift. Compare and clear atomically so a concurrent
 * /model request cannot lose its newer selection.
 */
export async function consolidateLiveModelSwitchAfterRun(params: {
  cfg?: OpenClawConfig | undefined;
  sessionKey?: string;
  agentId?: string;
  providerUsed?: string;
  modelUsed?: string;
}): Promise<void> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const cfg = params.cfg;
  const providerUsed = normalizeOptionalString(params.providerUsed);
  const modelUsed = normalizeOptionalString(params.modelUsed);
  if (!cfg || !sessionKey || !providerUsed || !modelUsed) {
    return;
  }
  // Store selection and default-model resolution both need the owning agent;
  // derive it from the session key when the caller has none, so agent-scoped
  // stores are targeted correctly and a completed /model default still
  // consolidates when config overrides the library-wide defaults.
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: params.agentId,
  });
  const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId });
  await patchSessionEntryCore(
    { storePath, sessionKey },
    (entry) => {
      if (!entry.liveModelSwitchPending) {
        return null;
      }
      const persisted = resolveSelectionFromSessionEntry({
        cfg,
        entry,
        agentId,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const selectionApplied =
        (providerUsed === persisted.provider && modelUsed === persisted.model) ||
        isAlreadyAppliedOpenAICodexRuntimePromotion(
          { provider: providerUsed, model: modelUsed },
          persisted,
        );
      if (!selectionApplied) {
        return null;
      }
      const next = { ...entry };
      delete next.liveModelSwitchPending;
      return next;
    },
    {
      replaceEntry: true,
      workerGuard: {},
      prepareIf: { kind: "live-model-switch-pending" },
    },
  );
}

/**
 * Consume only the observed selection; a newer request may commit while this clear queues.
 */
export async function clearLiveModelSwitchPending(params: {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
  expectedSelection: LiveSessionModelSelection;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: params.agentId?.trim(),
  });
  await patchSessionEntryCore(
    { storePath, sessionKey },
    (entry) => {
      if (
        !entry.liveModelSwitchPending ||
        hasDifferentLiveSessionModelSelection(
          params.expectedSelection,
          resolveSelectionFromSessionEntry({
            cfg,
            entry,
            agentId: params.agentId,
            defaultProvider: params.defaultProvider,
            defaultModel: params.defaultModel,
          }),
        )
      ) {
        return null;
      }
      const next = { ...entry };
      delete next.liveModelSwitchPending;
      return next;
    },
    {
      replaceEntry: true,
      workerGuard: {},
      prepareIf: { kind: "live-model-switch-pending" },
    },
  );
}

/**
 * Resolves and persists live-session model switch requests.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelRef } from "./model-ref-shared.js";
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";
import { resolveSessionRuntimeOverrideForProvider } from "./session-runtime-compat.js";
export { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
export type LiveSessionModelSelection = {
  provider: string;
  model: string;
  agentRuntimeOverride?: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai";

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
    normalizeProviderId(current.provider) === OPENAI_CODEX_PROVIDER_ID &&
    normalizeProviderId(next.provider) === OPENAI_PROVIDER_ID &&
    current.model === next.model
  );
}

function hasDifferentLiveSessionModelSelection(
  current: {
    provider: string;
    model: string;
    agentRuntimeOverride?: string;
    authProfileId?: string;
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
 * Check whether a user-initiated live model switch is pending for the given
 * session.  Returns the persisted model selection when the session's
 * `liveModelSwitchPending` flag is `true` AND the persisted selection differs
 * from the currently running model; otherwise returns `undefined`.
 *
 * When the flag is set but the current model already matches the persisted
 * selection (e.g. the switch was applied as an override and the current
 * attempt is already using the new model), the flag is consumed (cleared)
 * eagerly to prevent it from persisting as stale state.
 *
 * **Deferral semantics:** The caller in `run.ts` only acts on the returned
 * selection when `canRestartForLiveSwitch` is `true`.  If the run cannot
 * restart (e.g. a tool call is in progress), the flag intentionally remains
 * set so the switch fires on the next clean retry opportunity — even if that
 * falls into a subsequent user turn.
 *
 * This replaces the previous approach that used an in-memory run-state map,
 * which could not distinguish between
 * user-initiated `/model` switches and system-initiated fallback rotations.
 */
export function shouldSwitchToLiveModel(params: {
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
}): LiveSessionModelSelection | undefined {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  // A borrowed identity does not own the durable turn's pending switch.
  if (!cfg || !sessionKey || params.sessionPersistence === "detached") {
    return undefined;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: params.agentId?.trim(),
  });
  const entry = loadSessionEntryReadOnly({
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
    }).catch(() => {
      /* best-effort — fs/lock errors are non-fatal here */
    });
    return undefined;
  }
  return persisted;
}

/** Completion ignores runtime/auth drift: the selected model demonstrably ran. */
export function hasAppliedLiveModelSwitch(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  sessionKey: string;
  agentId?: string;
  selection: ModelRef;
}): boolean {
  const provider = normalizeOptionalString(params.selection.provider);
  const model = normalizeOptionalString(params.selection.model);
  if (!provider || !model) {
    return false;
  }
  const persisted = resolveSelectionFromSessionEntry({
    cfg: params.cfg,
    entry: params.entry,
    agentId: resolveSessionAgentId({
      sessionKey: params.sessionKey,
      config: params.cfg,
      agentId: params.agentId,
    }),
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  return (
    (provider === persisted.provider && model === persisted.model) ||
    isAlreadyAppliedOpenAICodexRuntimePromotion({ provider, model }, persisted)
  );
}

/**
 * Clear the `liveModelSwitchPending` flag from the session entry on disk so
 * subsequent retry iterations do not re-trigger the switch.
 */
export async function clearLiveModelSwitchPending(params: {
  cfg?: { session?: { store?: string } } | undefined;
  sessionKey?: string;
  agentId?: string;
}): Promise<void> {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return;
  }
  const storePath = resolveSessionStorePathCore(cfg.session?.store, {
    agentId: params.agentId?.trim(),
  });
  if (!storePath) {
    return;
  }
  await patchSessionEntryCore(
    { storePath, sessionKey },
    (entry) => {
      const next = { ...entry };
      delete next.liveModelSwitchPending;
      return next;
    },
    { replaceEntry: true },
  );
}

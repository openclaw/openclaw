/**
 * Resolves and persists live-session model switch requests.
 */
<<<<<<< HEAD
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionEntry, patchSessionEntry } from "../config/sessions/session-accessor.js";
=======
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions/store.js";
import type { EmbeddedRunModelSwitchRequest } from "./embedded-agent-runner/runs.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";
export { LiveSessionModelSwitchError } from "./live-model-switch-error.js";
<<<<<<< HEAD
export type LiveSessionModelSelection = {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";
};
=======
export type LiveSessionModelSelection = EmbeddedRunModelSwitchRequest;
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai";

export function resolveLiveSessionModelSelection(params: {
  cfg?: { session?: { store?: string } } | undefined;
  sessionKey?: string;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
}): LiveSessionModelSelection | null {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return null;
  }
  const agentId = normalizeOptionalString(params.agentId);
  const defaultModelRef = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
      })
    : { provider: params.defaultProvider, model: params.defaultModel };
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId,
  });
<<<<<<< HEAD
  const entry = loadSessionEntry({
    storePath,
    sessionKey,
    hydrateSkillPromptRefs: false,
    readConsistency: "latest",
  });
=======
  const entry = loadSessionStore(storePath, {
    hydrateSkillPromptRefs: false,
    skipCache: true,
  })[sessionKey];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
  const authProfileId = normalizeOptionalString(entry?.authProfileOverride);
  return {
    provider,
    model,
    authProfileId,
    authProfileIdSource: authProfileId ? entry?.authProfileOverrideSource : undefined,
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

export function hasDifferentLiveSessionModelSelection(
  current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: string;
  },
  next: LiveSessionModelSelection | null | undefined,
): next is LiveSessionModelSelection {
  if (!next) {
    return false;
  }
  const modelSelectionDiffers =
    (current.provider !== next.provider || current.model !== next.model) &&
    !isAlreadyAppliedOpenAICodexRuntimePromotion(current, next);
  return (
    modelSelectionDiffers ||
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
<<<<<<< HEAD
 * This replaces the previous approach that used an in-memory run-state map,
 * which could not distinguish between
=======
 * This replaces the previous approach that used an in-memory map
 * (`consumeEmbeddedRunModelSwitch`) which could not distinguish between
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
 * user-initiated `/model` switches and system-initiated fallback rotations.
 */
export function shouldSwitchToLiveModel(params: {
  cfg?: { session?: { store?: string } } | undefined;
  sessionKey?: string;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
  currentProvider: string;
  currentModel: string;
  currentAuthProfileId?: string;
  currentAuthProfileIdSource?: string;
}): LiveSessionModelSelection | undefined {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return undefined;
  }
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: params.agentId?.trim(),
  });
<<<<<<< HEAD
  const entry = loadSessionEntry({
    storePath,
    sessionKey,
    hydrateSkillPromptRefs: false,
    clone: false,
    readConsistency: "latest",
  });
=======
  const entry = loadSessionStore(storePath, {
    hydrateSkillPromptRefs: false,
    skipCache: true,
    clone: false,
  })[sessionKey];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  if (!entry?.liveModelSwitchPending) {
    return undefined;
  }
  const persisted = resolveLiveSessionModelSelection({
    cfg,
    sessionKey,
    agentId: params.agentId,
    defaultProvider: params.defaultProvider,
    defaultModel: params.defaultModel,
  });
  if (
    !hasDifferentLiveSessionModelSelection(
      {
        provider: params.currentProvider,
        model: params.currentModel,
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
  return persisted ?? undefined;
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
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId: params.agentId?.trim(),
  });
  if (!storePath) {
    return;
  }
<<<<<<< HEAD
  await patchSessionEntry(
    { storePath, sessionKey },
    (entry) => {
      const next = { ...entry };
      delete next.liveModelSwitchPending;
      return next;
    },
    { replaceEntry: true },
  );
=======
  await updateSessionStore(storePath, (store) => {
    const entry = store[sessionKey];
    if (entry) {
      delete entry.liveModelSwitchPending;
    }
  });
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

import { loadSessionStore, resolveStorePath, type SessionEntry } from "../config/sessions.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import {
  consumeEmbeddedRunModelSwitch,
  requestEmbeddedRunModelSwitch,
  type EmbeddedRunModelSwitchRequest,
} from "./pi-embedded-runner/runs.js";
import { abortEmbeddedPiRun } from "./pi-embedded.js";

export type LiveSessionModelSelection = EmbeddedRunModelSwitchRequest;

export class LiveSessionModelSwitchError extends Error {
  provider: string;
  model: string;
  authProfileId?: string;
  authProfileIdSource?: "auto" | "user";

  constructor(selection: LiveSessionModelSelection) {
    super(`Live session model switch requested: ${selection.provider}/${selection.model}`);
    this.name = "LiveSessionModelSwitchError";
    this.provider = selection.provider;
    this.model = selection.model;
    this.authProfileId = selection.authProfileId;
    this.authProfileIdSource = selection.authProfileIdSource;
  }
}

export function resolveLiveSessionModelSelection(params: {
  cfg?: { session?: { store?: string } } | undefined;
  sessionKey?: string;
  agentId?: string;
  defaultProvider: string;
  defaultModel: string;
}): LiveSessionModelSelection | null {
  const sessionKey = params.sessionKey?.trim();
  const cfg = params.cfg;
  if (!cfg || !sessionKey) {
    return null;
  }
  const agentId = params.agentId?.trim();
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId,
  });
  const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];

  // Upstream: prefer runtime fields written by the runner.
  const runtimeProvider = entry?.modelProvider?.trim();
  const runtimeModel = entry?.model?.trim();

  // When the session entry has an explicit modelOverride (set via /model or
  // inherited from a parent session write), honour it.  Otherwise fall back to
  // the caller-supplied defaults which already reflect the resolved model for
  // this run (including parent-session overrides, heartbeat model config, etc.).
  // Previously this branch unconditionally used resolveDefaultModelForAgent()
  // which returns the *config-level* default and ignores any runtime model
  // resolution performed by the auto-reply / agent-command layer.  That caused
  // child/heartbeat/thread sessions whose resolved model differs from the
  // config default to trigger a spurious LiveSessionModelSwitchError on every
  // attempt, effectively inverting the fallback order (#57063, #56788).
  const hasExplicitOverride = Boolean(entry?.modelOverride?.trim());
  const callerDefault = { provider: params.defaultProvider, model: params.defaultModel };

  // Always resolve the config-level default when an agentId is present so that
  // mid-run `/model reset` (clearing modelOverride) is detected as a switch
  // back to the agent default rather than silently staying on callerDefault.
  const configDefault = agentId
    ? resolveDefaultModelForAgent({ cfg, agentId })
    : callerDefault;

  // When there is an explicit override, use it; when the session entry exists
  // but has no override, use callerDefault (the in-flight resolved model);
  // when there is no entry at all, use configDefault so that a cleared
  // override is distinguishable from "never set".
  const entryExists = entry !== undefined && entry !== null;

  const provider = runtimeProvider
    || (hasExplicitOverride
      ? (entry.providerOverride?.trim() || configDefault.provider)
      : entryExists ? callerDefault.provider : configDefault.provider);
  const model = runtimeModel
    || (hasExplicitOverride
      ? entry.modelOverride!.trim()
      : entryExists ? callerDefault.model : configDefault.model);

  const authProfileId = entry?.authProfileOverride?.trim() || undefined;
  return {
    provider,
    model,
    authProfileId,
    authProfileIdSource: authProfileId ? entry?.authProfileOverrideSource : undefined,
  };
}

export function requestLiveSessionModelSwitch(params: {
  sessionEntry?: Pick<SessionEntry, "sessionId">;
  selection: LiveSessionModelSelection;
}): boolean {
  const sessionId = params.sessionEntry?.sessionId?.trim();
  if (!sessionId) {
    return false;
  }
  const aborted = abortEmbeddedPiRun(sessionId);
  if (!aborted) {
    return false;
  }
  requestEmbeddedRunModelSwitch(sessionId, params.selection);
  return true;
}

export function consumeLiveSessionModelSwitch(
  sessionId: string,
): LiveSessionModelSelection | undefined {
  return consumeEmbeddedRunModelSwitch(sessionId);
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
  return (
    current.provider !== next.provider ||
    current.model !== next.model ||
    (current.authProfileId?.trim() || undefined) !== next.authProfileId ||
    (current.authProfileId?.trim() ? current.authProfileIdSource : undefined) !==
      next.authProfileIdSource
  );
}

export function shouldTrackPersistedLiveSessionModelSelection(
  current: {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: string;
  },
  persisted: LiveSessionModelSelection | null | undefined,
): boolean {
  return !hasDifferentLiveSessionModelSelection(current, persisted);
}

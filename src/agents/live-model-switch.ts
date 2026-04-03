import { loadSessionStore, resolveStorePath, type SessionEntry } from "../config/sessions.js";
import { resolveDefaultModelForAgent, resolvePersistedModelRef } from "./model-selection.js";
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
  const defaultModelRef = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
      })
    : { provider: params.defaultProvider, model: params.defaultModel };
  const storePath = resolveStorePath(cfg.session?.store, {
    agentId,
  });
  const entry = loadSessionStore(storePath, { skipCache: true })[sessionKey];
  const persisted = resolvePersistedModelRef({
    defaultProvider: defaultModelRef.provider,
    runtimeProvider: entry?.modelProvider,
    runtimeModel: entry?.model,
    overrideProvider: entry?.providerOverride,
    overrideModel: entry?.modelOverride,
  });
  const provider =
    persisted?.provider ?? entry?.providerOverride?.trim() ?? defaultModelRef.provider;
  const model = persisted?.model ?? defaultModelRef.model;
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

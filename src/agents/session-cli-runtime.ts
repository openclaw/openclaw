import { resolveCollapsedSessionAuthPinSource } from "../config/sessions/auth-profile-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAvailableAgentHarnessPolicy } from "./harness/selection.js";
import {
  isCliRuntimeAliasForProvider,
  resolveCliRuntimeExecutionProvider,
} from "./model-runtime-aliases.js";

/**
 * The CLI backend that runs a session's model, or undefined when the built-in runtime runs it.
 * A user auth pin selects its own backend; otherwise the auth order and the configured runtime
 * decide. `authProfileId` is set only when the session's pin selected the backend.
 */
export function resolveSessionCliRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  provider: string;
  model: string;
  sessionEntry: Pick<
    SessionEntry,
    "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
  >;
}): { provider: string; authProfileId?: string } | undefined {
  const sessionAuthProfileId = params.sessionEntry.authProfileOverride?.trim() || undefined;
  const selection = {
    provider: params.provider,
    cfg: params.cfg,
    agentId: params.agentId,
    modelId: params.model,
  };
  const fromSessionAuth = sessionAuthProfileId
    ? resolveCliRuntimeExecutionProvider({
        ...selection,
        authProfileId: sessionAuthProfileId,
      })?.trim()
    : undefined;
  if (fromSessionAuth) {
    return { provider: fromSessionAuth, authProfileId: sessionAuthProfileId };
  }
  const fromAuthOrder =
    !sessionAuthProfileId || resolveCollapsedSessionAuthPinSource(params.sessionEntry) === "auto"
      ? resolveCliRuntimeExecutionProvider(selection)?.trim()
      : undefined;
  if (fromAuthOrder) {
    return { provider: fromAuthOrder };
  }
  const runtime = resolveAvailableAgentHarnessPolicy({
    provider: params.provider,
    modelId: params.model,
    config: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  }).runtime.trim();
  return isCliRuntimeAliasForProvider({ runtime, provider: params.provider, cfg: params.cfg })
    ? { provider: runtime }
    : undefined;
}

/**
 * Resolves fast-mode state from agent config and runtime defaults.
 */
<<<<<<< HEAD
import type { FastMode } from "@openclaw/normalization-core/string-coerce";
import { normalizeFastMode } from "../auto-reply/thinking.shared.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  type FastModeSource,
  resolveFastModeModelAutoOnSeconds,
  resolveFastModeModelParams,
} from "../shared/fast-mode.js";
import { resolveAgentConfig } from "./agent-scope.js";

export {
  DEFAULT_FAST_MODE_AUTO_ON_SECONDS,
  formatFastModeAutoLabel,
  formatFastModeAutoProgressText,
  formatFastModeCommandOptions,
  formatFastModeCurrentStatus,
  formatFastModeSourceSuffix,
  formatFastModeStatusValue,
  formatFastModeValue,
  normalizeFastModeAutoOnSeconds,
  normalizeFastModeSource,
  resolveFastModeForElapsed,
  resolveFastModeModelAutoOnSeconds,
} from "../shared/fast-mode.js";
export type { FastMode } from "@openclaw/normalization-core/string-coerce";
export type { FastModeAutoProgressState } from "../shared/fast-mode.js";
=======
import { normalizeFastMode } from "../auto-reply/thinking.shared.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope.js";
import { modelKey } from "./model-ref-shared.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

// Resolves effective fast-mode state from session, agent, model config, then
// default. Callers keep the source for diagnostics and prompt explanations.
type FastModeState = {
<<<<<<< HEAD
  mode: FastMode;
  enabled: boolean;
  source: FastModeSource;
  fastAutoOnSeconds: number;
=======
  enabled: boolean;
  source: "session" | "agent" | "config" | "default";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
};

function resolveConfiguredFastModeRaw(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): unknown {
<<<<<<< HEAD
  const modelParams = resolveFastModeModelParams(params);
  return modelParams?.fastMode ?? modelParams?.fast_mode;
=======
  const modelConfig =
    params.cfg?.agents?.defaults?.models?.[modelKey(params.provider, params.model)];
  return modelConfig?.params?.fastMode ?? modelConfig?.params?.fast_mode;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

/** Resolve the effective fast-mode setting and its source. */
export function resolveFastModeState(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentId?: string;
  sessionEntry?: Pick<SessionEntry, "fastMode"> | undefined;
}): FastModeState {
<<<<<<< HEAD
  const fastAutoOnSeconds = resolveFastModeModelAutoOnSeconds(params);
  const sessionOverride = normalizeFastMode(params.sessionEntry?.fastMode);
  if (sessionOverride !== undefined) {
    return {
      mode: sessionOverride,
      enabled: sessionOverride === "auto" ? true : sessionOverride,
      source: "session",
      fastAutoOnSeconds,
    };
=======
  const sessionOverride = normalizeFastMode(params.sessionEntry?.fastMode);
  if (sessionOverride !== undefined) {
    return { enabled: sessionOverride, source: "session" };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  }

  const agentDefault =
    params.agentId && params.cfg
      ? resolveAgentConfig(params.cfg, params.agentId)?.fastModeDefault
      : undefined;
<<<<<<< HEAD
  const normalizedAgentDefault = normalizeFastMode(agentDefault);
  if (normalizedAgentDefault !== undefined) {
    return {
      mode: normalizedAgentDefault,
      enabled: normalizedAgentDefault === "auto" ? true : normalizedAgentDefault,
      source: "agent",
      fastAutoOnSeconds,
    };
=======
  if (typeof agentDefault === "boolean") {
    return { enabled: agentDefault, source: "agent" };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  }

  const configuredRaw = resolveConfiguredFastModeRaw(params);
  const configured = normalizeFastMode(configuredRaw as string | boolean | null | undefined);
  if (configured !== undefined) {
<<<<<<< HEAD
    return {
      mode: configured,
      enabled: configured === "auto" ? true : configured,
      source: "config",
      fastAutoOnSeconds,
    };
  }

  return {
    mode: false,
    enabled: false,
    source: "default",
    fastAutoOnSeconds,
  };
=======
    return { enabled: configured, source: "config" };
  }

  return { enabled: false, source: "default" };
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
}

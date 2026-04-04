import { normalizeFastMode } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";

export type FastModeState = {
  enabled: boolean;
  source: "session" | "config" | "default";
};

export function resolveFastModeParam(
  extraParams: Record<string, unknown> | undefined,
): boolean | undefined {
  return normalizeFastMode(
    (extraParams?.fastMode ?? extraParams?.fast_mode) as string | boolean | null | undefined,
  );
}

function resolveConfiguredFastModeRaw(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): unknown {
  const modelKey = `${params.provider}/${params.model}`;
  const modelConfig = params.cfg?.agents?.defaults?.models?.[modelKey];
  return modelConfig?.params?.fastMode ?? modelConfig?.params?.fast_mode;
}

export function resolveConfiguredFastMode(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
}): boolean {
  return (
    normalizeFastMode(
      resolveConfiguredFastModeRaw(params) as string | boolean | null | undefined,
    ) ?? false
  );
}

export function resolveFastModeState(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  sessionEntry?: Pick<SessionEntry, "fastMode"> | undefined;
  agentCfg?: {
    fastModeDefault?: unknown;
  };
}): FastModeState {
  const sessionOverride = normalizeFastMode(params.sessionEntry?.fastMode);
  if (sessionOverride !== undefined) {
    return { enabled: sessionOverride, source: "session" };
  }

  const agentDefault = normalizeFastMode(
    params.agentCfg?.fastModeDefault as string | boolean | null | undefined,
  );
  if (agentDefault !== undefined) {
    return { enabled: agentDefault, source: "config" };
  }

  const configuredRaw = resolveConfiguredFastModeRaw(params);
  const configured = normalizeFastMode(configuredRaw as string | boolean | null | undefined);
  if (configured !== undefined) {
    return { enabled: configured, source: "config" };
  }

  return { enabled: false, source: "default" };
}

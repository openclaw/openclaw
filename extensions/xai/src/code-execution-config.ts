import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isXaiToolEnabled, type XaiToolAuthContext } from "./tool-auth-shared.js";

type CodeExecutionConfig = {
  enabled?: boolean;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
};

export function readPluginCodeExecutionConfig(cfg?: unknown): CodeExecutionConfig | undefined {
  if (!cfg || typeof cfg !== "object") {
    return undefined;
  }
  const plugins = (cfg as OpenClawConfig).plugins;
  const entries = plugins && typeof plugins === "object" ? plugins.entries : undefined;
  const entry = entries && entries.xai;
  const config = entry && typeof entry === "object" ? entry.config : undefined;
  const value = config && typeof config === "object" ? config.codeExecution : undefined;
  return value && typeof value === "object" ? (value as CodeExecutionConfig) : undefined;
}

export function resolveCodeExecutionEnabled(params: {
  sourceConfig?: unknown;
  runtimeConfig?: unknown;
  config?: CodeExecutionConfig;
  auth?: XaiToolAuthContext;
}): boolean {
  return isXaiToolEnabled({
    enabled: params.config?.enabled,
    runtimeConfig: params.runtimeConfig as never,
    sourceConfig: params.sourceConfig as never,
    auth: params.auth,
  });
}

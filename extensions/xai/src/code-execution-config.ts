import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isXaiToolEnabled, type XaiToolAuthContext } from "./tool-auth-shared.js";

type CodeExecutionConfig = {
  enabled?: boolean;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
};

export function readPluginCodeExecutionConfig(
  cfg?: OpenClawConfig,
): CodeExecutionConfig | undefined {
  const config = cfg?.plugins?.entries?.xai?.config;
  const value = config && typeof config === "object" ? config.codeExecution : undefined;
  return value && typeof value === "object" ? (value as CodeExecutionConfig) : undefined;
}

export function resolveCodeExecutionEnabled(params: {
  sourceConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  config?: CodeExecutionConfig;
  auth?: XaiToolAuthContext;
}): boolean {
  return isXaiToolEnabled({
    enabled: params.config?.enabled,
    runtimeConfig: params.runtimeConfig,
    sourceConfig: params.sourceConfig,
    auth: params.auth,
  });
}

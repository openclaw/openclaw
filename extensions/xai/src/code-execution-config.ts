import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import { asOptionalObjectRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
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
  return asOptionalObjectRecord(resolvePluginConfigObject(cfg, "xai")?.codeExecution);
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

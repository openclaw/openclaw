import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";

//#region src/gateway/resolve-configured-secret-input-string.d.ts
type SecretInputUnresolvedReasonStyle = "generic" | "detailed";
type ConfiguredSecretInputSource = "config" | "secretRef" | "fallback";
declare function resolveConfiguredSecretInputString(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<{
  value?: string;
  unresolvedRefReason?: string;
}>;
declare function resolveConfiguredSecretInputWithFallback(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
  readFallback?: () => string | undefined;
}): Promise<{
  value?: string;
  source?: ConfiguredSecretInputSource;
  unresolvedRefReason?: string;
  secretRefConfigured: boolean;
}>;
declare function resolveRequiredConfiguredSecretRefInputString(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  value: unknown;
  path: string;
  unresolvedReasonStyle?: SecretInputUnresolvedReasonStyle;
}): Promise<string | undefined>;
//#endregion
export { resolveConfiguredSecretInputWithFallback as n, resolveRequiredConfiguredSecretRefInputString as r, resolveConfiguredSecretInputString as t };
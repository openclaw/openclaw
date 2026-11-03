import path from "node:path";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.js";
import {
  installationTargetEnv,
  type InstallationTarget,
} from "../../infra/installation-target-context.js";
import { applyPathPrepend, findPathKey, normalizePathPrepend } from "../../infra/path-prepend.js";
import type { PluginRegistry } from "../../plugins/registry-types.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { resolveSessionAgentIdStrict } from "../agent-scope.js";
import { capturePreparedExecutionEnvironment } from "../execution-environment.js";
import { resolveExecToolConfig } from "../lazy-exec-tool.js";

const MAX_NATIVE_OPERATION_CWD_BYTES = 4096;

export function normalizeNativeOperationCwd(
  value: unknown,
  attemptCwd: string | undefined,
): string {
  if (typeof value !== "string") {
    throw new Error("native operation cwd must be a string");
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("native operation cwd must not be empty");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_NATIVE_OPERATION_CWD_BYTES) {
    throw new Error(`native operation cwd must not exceed ${MAX_NATIVE_OPERATION_CWD_BYTES} bytes`);
  }
  if (containsAsciiControlCharacter(normalized)) {
    throw new Error("native operation cwd must not contain control characters");
  }
  return path.resolve(attemptCwd ?? process.cwd(), normalized);
}

/** Capture non-secret environment facts once; the harness owns their placement. */
export function prepareAgentHarnessEnvironment(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  sandboxAgentId?: string;
  installationTarget?: InstallationTarget;
  pluginRegistry?: PluginRegistry;
  assertCurrent: () => void;
  signal?: AbortSignal;
}) {
  const execConfig = resolveExecToolConfig({
    cfg: params.config,
    agentId: params.sandboxAgentId ?? resolveSessionAgentIdStrict(params),
  });
  // The automatic CLI shim alone must not change native login-shell defaults.
  const hasConfiguredPrefix = normalizePathPrepend(execConfig.configuredPathPrepend).length > 0;
  // Capture only tool lookup, not arbitrary host environment or installation custody.
  // SAFETY: findPathKey reads only key names, so optional process.env values are unused.
  const pathKey = findPathKey(process.env as Record<string, string>);
  const localToolEnv = hasConfiguredPrefix ? { [pathKey]: process.env[pathKey] ?? "" } : undefined;
  const localToolPathPrepend = hasConfiguredPrefix
    ? Object.freeze(normalizePathPrepend(execConfig.pathPrepend))
    : undefined;
  if (localToolEnv && localToolPathPrepend) {
    applyPathPrepend(localToolEnv, [...localToolPathPrepend]);
    Object.freeze(localToolEnv);
  }
  const secrets = getActiveSecretsRuntimeConfigSnapshot();
  const identity = capturePreparedExecutionEnvironment(
    {
      config: params.config ?? {},
      sourceConfig: secrets?.sourceConfig,
      agentId: resolveSessionAgentIdStrict(params),
      assertCurrent: params.assertCurrent,
      signal: params.signal,
    },
    params.pluginRegistry ?? getPluginRuntimeGatewayRequestScope()?.pluginRegistry,
    secrets?.executionEnvironmentExclusions,
  );
  const localProcessEnv = installationTargetEnv(params.installationTarget);
  return Object.freeze({
    ...identity,
    // Preserve the existing harness result field while plugins own identity selection.
    managedLocalIdentity: Object.keys(identity.localIdentityEnv).length > 0,
    ...(localProcessEnv ? { localProcessEnv } : {}),
    ...(localToolEnv ? { localToolEnv, localToolPathPrepend } : {}),
  });
}

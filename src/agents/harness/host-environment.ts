import path from "node:path";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.js";
import {
  installationTargetEnv,
  type InstallationTarget,
} from "../../infra/installation-target-context.js";
import { applyPathPrepend, findPathKey, normalizePathPrepend } from "../../infra/path-prepend.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { resolveSessionAgentIdStrict } from "../agent-scope.js";
import type { OpenClawCodingToolsOptions } from "../agent-tools.options.js";
import { prepareLocalGitHubEnvironment } from "../github-local-environment.js";
import { prepareGitHubToolEnvironment } from "../github-tool-identity.js";
import { resolveExecToolConfig } from "../lazy-exec-tool.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

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
}): ReturnType<NonNullable<AgentHarnessHostCapabilities["preparedEnvironment"]>> {
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
  const identity = prepareGitHubToolEnvironment({
    config: params.config ?? {},
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig,
    agentId: params.agentId ?? "main",
  });
  const localProcessEnv = installationTargetEnv(params.installationTarget);
  return Object.freeze({
    credentialScrubEnv: Object.freeze({ ...identity.credentialScrubEnv }),
    localIdentityEnv: Object.freeze({ ...identity.localIdentityEnv }),
    managedLocalIdentity: identity.managedLocalIdentity,
    ...(localProcessEnv ? { localProcessEnv } : {}),
    ...(localToolEnv ? { localToolEnv, localToolPathPrepend } : {}),
  });
}

/** Bind local credential preparation to this host capability and requesting operation. */
export function bindLocalGitHubEnvironment(
  input: Pick<
    Parameters<typeof prepareLocalGitHubEnvironment>[0],
    "admittedRunContext" | "agentId" | "config" | "sessionId" | "sessionKey"
  >,
  params: { assertActive: () => void; signal: AbortSignal },
) {
  const { admittedRunContext, agentId, config, sessionId, sessionKey } = input;
  let prepared: Awaited<ReturnType<typeof prepareLocalGitHubEnvironment>>;
  const prepare: NonNullable<
    AgentHarnessHostCapabilities["prepareLocalGitHubEnvironment"]
  > = async (request) => {
    const candidate = await prepareLocalGitHubEnvironment({
      admittedRunContext,
      agentId,
      config,
      sessionId,
      sessionKey,
      assertCurrent: () => {
        params.assertActive();
        request.assertCurrent();
      },
      signal: AbortSignal.any([request.signal, params.signal]),
    });
    try {
      params.assertActive();
      request.assertCurrent();
      candidate?.assertCurrent();
      prepared = candidate;
      return candidate;
    } catch (error) {
      await candidate?.dispose();
      throw error;
    }
  };
  return Object.assign(prepare, {
    withExecEnvironment(
      options: OpenClawCodingToolsOptions | undefined,
      base: ReturnType<typeof prepareAgentHarnessEnvironment>,
      local: boolean,
    ): OpenClawCodingToolsOptions | undefined {
      params.assertActive();
      prepared?.assertCurrent();
      if (!prepared || !local || options?.sandbox?.enabled) {
        return options;
      }
      return {
        ...options,
        exec: {
          ...options?.exec,
          preparedRunEnvironment: {
            ...base,
            localIdentityEnv: { ...base.localIdentityEnv, ...prepared.env },
            excludedStoreNames: Object.keys(base.credentialScrubEnv),
            managedLocalIdentity: true,
          },
        },
      };
    },
  });
}

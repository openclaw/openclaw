import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SystemRunExecutionContext } from "../../packages/gateway-protocol/src/system-run-execution-context.js";
import { normalizeChatChannelId } from "../channels/ids.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { ExecHost } from "../infra/exec-approvals.js";
import {
  isDangerousHostEnvOverrideVarName,
  isDangerousHostEnvVarName,
  normalizeHostOverrideEnvVarKey,
  sanitizeHostExecEnvWithDiagnostics,
} from "../infra/host-env-security.js";
import {
  getInstallationTarget,
  installationTargetEnv,
  LOCAL_INSTALLATION_TARGET_UNSUPPORTED,
} from "../infra/installation-target-context.js";
import { omitGatewayAgentCliPath } from "../infra/openclaw-cli-shim.js";
import { OPENCLAW_CLI_ENV_VAR, buildExecRoutingEnv } from "../infra/openclaw-exec-env.js";
import { mergeProcessEnv, resolveEnvironmentValue } from "../infra/process-env.js";
import {
  getShellPathFromLoginShell,
  resolveShellEnvFallbackTimeoutMs,
} from "../infra/shell-env.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import type { HookContext } from "./agent-tools.before-tool-call.js";
import { stripMalformedXmlArgValueSuffixFromKeys } from "./agent-tools.params.js";
import { DEFAULT_PATH, applyPathPrepend, applyShellPath } from "./bash-tools.exec-runtime.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import { type ExecWorkdirResolution, resolveExecWorkdir } from "./bash-tools.exec-workdir.js";
import { buildSandboxEnv, coerceEnv } from "./bash-tools.shared.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { prepareGitHubToolEnvironment } from "./github-tool-identity.js";
import { sanitizeEnvVars } from "./sandbox/sanitize-env-vars.js";
import { isSubagentEnvelopeSession } from "./subagents/spawn/subagent-capabilities.js";
import { ToolInputError } from "./tools/common.js";

export type ExecToolArgs = Record<string, unknown> & {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  yieldMs?: number;
  background?: boolean;
  awaitResults?: boolean;
  timeoutSeconds?: number;
  pty?: boolean;
  elevated?: boolean;
  host?: string;
  ask?: string;
  node?: string;
};

type ResolvedExecEnvPreparedState = {
  host?: ExecHost;
  pluginEnv?: Record<string, string>;
};
type ResolvedExecWorkdirPreparedState = {
  host: ExecHost;
  inputWorkdir?: string;
  resolution: ExecWorkdirResolution;
};

const resolvedExecEnvPreparedStates = new WeakMap<ExecToolArgs, ResolvedExecEnvPreparedState>();
const execHookContexts = new WeakMap<ExecToolArgs, HookContext | undefined>();
const resolvedExecWorkdirPreparedStates = new WeakMap<
  ExecToolArgs,
  ResolvedExecWorkdirPreparedState
>();
const XML_ARG_VALUE_EXEC_PARAM_KEYS = ["command", "workdir", "host", "ask", "node"] as const;

export function assertSupportedExecParams(args: unknown): void {
  if (!isRecord(args)) {
    return;
  }
  if (args.awaitResults !== undefined && typeof args.awaitResults !== "boolean") {
    throw new ToolInputError("exec awaitResults must be a boolean");
  }
  if (args.awaitResults === true && args.background === true) {
    throw new ToolInputError("exec with awaitResults=true cannot be detached with background=true");
  }
  if (Object.hasOwn(args, "timeout")) {
    throw new ToolInputError(
      'exec parameter "timeout" is unsupported; use "timeoutSeconds" instead',
    );
  }
  // `cwd` is a tool-level default, never a model-facing parameter: a dropped cwd runs the
  // command somewhere the caller did not choose, and the failure surfaces as a path the
  // caller never named.
  if (Object.hasOwn(args, "cwd")) {
    throw new ToolInputError('exec parameter "cwd" is unsupported; use "workdir" instead');
  }
}

function isExecToolArgsObject(value: unknown): value is ExecToolArgs {
  return isRecord(value);
}

function filterPluginExecEnv(rawEnv: Record<string, string>): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const [rawKey, value] of Object.entries(rawEnv)) {
    const key = normalizeHostOverrideEnvVarKey(rawKey);
    if (!key) {
      continue;
    }
    const upperKey = key.toUpperCase();
    if (
      upperKey === "PATH" ||
      upperKey === OPENCLAW_CLI_ENV_VAR ||
      isDangerousHostEnvVarName(upperKey) ||
      isDangerousHostEnvOverrideVarName(upperKey)
    ) {
      continue;
    }
    env[key] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function resolveNotifyOnExitEmptySuccess(defaults?: ExecToolDefaults): boolean {
  if (typeof defaults?.notifyOnExitEmptySuccess === "boolean") {
    return defaults.notifyOnExitEmptySuccess;
  }
  return normalizeChatChannelId(defaults?.messageProvider) !== null;
}

/** Capture notification routing and child identity before process lifetime detaches. */
export function resolveExecNotificationDefaults(defaults?: ExecToolDefaults) {
  const notifyOnExit = defaults?.notifyOnExit !== false;
  const notifyOnExitEmptySuccess = resolveNotifyOnExitEmptySuccess(defaults);
  const notifySessionKey = normalizeOptionalString(
    defaults?.notifySessionKey ?? defaults?.runSessionKey ?? defaults?.sessionKey,
  );
  const notifyAgentSession = parseAgentSessionKey(notifySessionKey);
  // Resolve before dispatch and retain the fact after the child registry retires.
  // One tool instance belongs to one run; worker reads avoid blocking the Gateway.
  let subagentSession: Promise<boolean> | undefined;
  const resolveSubagentSession = () =>
    (subagentSession ??= (async () => {
      if (
        !notifySessionKey ||
        !defaults?.config ||
        !notifyAgentSession?.rest.startsWith("dashboard:")
      ) {
        return isSubagentEnvelopeSession(notifySessionKey);
      }
      const { readSessionEntriesFromStoreInWorker } =
        await import("../config/sessions/session-entry-read-runtime.js");
      const read = await readSessionEntriesFromStoreInWorker({
        agentId: notifyAgentSession.agentId,
        sessionKeys: [notifySessionKey],
        snapshotFields: [],
        storePath: resolveSessionStorePathCore(defaults.config.session?.store, {
          agentId: notifyAgentSession.agentId,
        }),
      });
      return isSubagentEnvelopeSession(notifySessionKey, {
        entry: read.entries.find(({ sessionKey }) => sessionKey === notifySessionKey)?.entry,
      });
    })().catch(() => {
      // Identity enrichment must not prevent exec; retry the worker on the next call.
      subagentSession = undefined;
      return isSubagentEnvelopeSession(notifySessionKey);
    }));
  const notifyDeliveryContext = normalizeDeliveryContext({
    channel: defaults?.messageProvider,
    to: defaults?.currentChannelId,
    accountId: defaults?.accountId,
    threadId: defaults?.currentThreadTs,
  });
  return {
    notifyOnExit,
    notifyOnExitEmptySuccess,
    notifySessionKey,
    resolveSubagentSession,
    notifyDeliveryContext,
  };
}

export function resolveExecPreparedRunEnvironment(defaults?: ExecToolDefaults) {
  return {
    ...(defaults?.preparedRunEnvironment ??
      prepareGitHubToolEnvironment({
        config: defaults?.config ?? {},
        agentId: defaults?.agentId ?? "main",
      })),
    localProcessEnv: installationTargetEnv(getInstallationTarget()),
  };
}

export function createExecRequestPreparation(params: {
  defaults?: ExecToolDefaults;
  agentId?: string;
  resolveHostForParams: (params: ExecToolArgs) => ExecHost;
}) {
  const normalizeParams = (rawArgs: unknown): ExecToolArgs =>
    stripMalformedXmlArgValueSuffixFromKeys(rawArgs as ExecToolArgs, XML_ARG_VALUE_EXEC_PARAM_KEYS);

  const prepareParamsWithResolvedExecWorkdir = async (rawArgs: unknown): Promise<ExecToolArgs> => {
    if (typeof rawArgs !== "object" || rawArgs === null || Array.isArray(rawArgs)) {
      return rawArgs as ExecToolArgs;
    }
    const execParams = normalizeParams(rawArgs);
    let host: ExecHost;
    try {
      host = params.resolveHostForParams(execParams);
    } catch {
      return execParams;
    }
    if (host === "sandbox" && !params.defaults?.sandbox) {
      return execParams;
    }
    if (host === "sandbox" && params.defaults?.sandbox?.workdirValidation === "backend") {
      return execParams;
    }
    const resolution = await resolveExecWorkdir({
      host,
      workdir: execParams.workdir,
      defaultCwd: params.defaults?.cwd,
      nodeCwd: params.defaults?.nodeCwd,
      sandbox: params.defaults?.sandbox,
    });
    resolvedExecWorkdirPreparedStates.set(execParams, {
      host,
      inputWorkdir: execParams.workdir,
      resolution,
    });
    return execParams;
  };

  const shouldDeferResolveExecEnvUntilWorkdirValidated = (execParams: ExecToolArgs): boolean => {
    try {
      return (
        params.resolveHostForParams(execParams) === "sandbox" &&
        params.defaults?.sandbox?.workdirValidation === "backend"
      );
    } catch {
      return false;
    }
  };

  const prepareParamsWithResolvedExecEnv = async (
    rawArgs: unknown,
    context?: { hookContext?: HookContext },
  ): Promise<ExecToolArgs> => {
    const execParams = normalizeParams(rawArgs);
    if (!execParams.command) {
      return execParams;
    }
    if (resolvedExecEnvPreparedStates.has(execParams)) {
      return execParams;
    }
    const hookRunner = getGlobalHookRunner();
    if (
      !hookRunner?.hasHooks("resolve_exec_env") ||
      typeof hookRunner.runResolveExecEnv !== "function"
    ) {
      resolvedExecEnvPreparedStates.set(execParams, {});
      return execParams;
    }
    let host: ExecHost;
    try {
      host = params.resolveHostForParams(execParams);
    } catch {
      return execParams;
    }
    const sessionId = context?.hookContext?.sessionId ?? params.defaults?.sessionId;
    const rawPluginEnv = await hookRunner.runResolveExecEnv(
      {
        sessionKey: context?.hookContext?.sessionKey ?? params.defaults?.sessionKey,
        toolName: "exec",
        host,
      },
      {
        agentId: context?.hookContext?.agentId ?? params.agentId,
        sessionKey: context?.hookContext?.sessionKey ?? params.defaults?.sessionKey,
        ...(sessionId ? { sessionId } : {}),
        messageProvider: params.defaults?.messageProvider,
        channelId: params.defaults?.currentChannelId ?? context?.hookContext?.channelId,
        ...(params.defaults?.channelContext
          ? { channelContext: params.defaults.channelContext }
          : {}),
      },
    );
    const pluginEnv = filterPluginExecEnv(rawPluginEnv);
    resolvedExecEnvPreparedStates.set(execParams, {
      host,
      ...(pluginEnv ? { pluginEnv } : {}),
    });
    return execParams;
  };

  const prepareBeforeToolCallParams = async (
    args: unknown,
    context: { hookContext?: unknown },
  ): Promise<ExecToolArgs> => {
    assertSupportedExecParams(args);
    const execParams = await prepareParamsWithResolvedExecWorkdir(args);
    if (!isExecToolArgsObject(execParams)) {
      return execParams;
    }
    const hookContext = context.hookContext as HookContext | undefined;
    execHookContexts.set(execParams, hookContext);
    const workdirState = resolvedExecWorkdirPreparedStates.get(execParams);
    if (
      workdirState?.resolution.kind === "unavailable" ||
      shouldDeferResolveExecEnvUntilWorkdirValidated(execParams)
    ) {
      return execParams;
    }
    return prepareParamsWithResolvedExecEnv(execParams, { hookContext });
  };

  const finalizeBeforeToolCallParams = (rawParams: unknown, preparedParams: unknown) => {
    const envState = resolvedExecEnvPreparedStates.get(preparedParams as ExecToolArgs);
    const hookContext = execHookContexts.get(preparedParams as ExecToolArgs);
    const workdirState = resolvedExecWorkdirPreparedStates.get(preparedParams as ExecToolArgs);
    if (!envState && !hookContext && !workdirState) {
      return rawParams;
    }
    if (!isExecToolArgsObject(rawParams)) {
      return rawParams;
    }
    const execParams = rawParams;
    // Host/workdir rewrites invalidate cached facts, not the bound execution identity.
    const invalidatePreparedParams = () => {
      const invalidated = { ...execParams };
      execHookContexts.set(invalidated, hookContext);
      return invalidated;
    };
    let host: ExecHost | undefined;
    const resolveFinalHost = () => {
      host ??= params.resolveHostForParams(execParams);
      return host;
    };
    try {
      if (envState?.host && execParams.command && resolveFinalHost() !== envState.host) {
        return invalidatePreparedParams();
      }
      if (
        workdirState &&
        (resolveFinalHost() !== workdirState.host ||
          execParams.workdir !== workdirState.inputWorkdir)
      ) {
        return invalidatePreparedParams();
      }
    } catch {
      return invalidatePreparedParams();
    }
    if (envState) {
      resolvedExecEnvPreparedStates.set(execParams, envState);
    }
    if (hookContext) {
      execHookContexts.set(execParams, hookContext);
    }
    if (workdirState) {
      resolvedExecWorkdirPreparedStates.set(execParams, workdirState);
    }
    return execParams;
  };

  return {
    normalizeParams,
    prepareBeforeToolCallParams,
    finalizeBeforeToolCallParams,
    prepareParamsWithResolvedExecEnv,
    isResolveExecEnvPrepared: (args: ExecToolArgs) => resolvedExecEnvPreparedStates.has(args),
    getExecHookContext: (args: ExecToolArgs) => execHookContexts.get(args),
    getResolvedExecWorkdirPreparedState: (args: ExecToolArgs) =>
      resolvedExecWorkdirPreparedStates.get(args),
    getResolvedExecEnvPreparedState: (args: ExecToolArgs) =>
      resolvedExecEnvPreparedStates.get(args),
  };
}

export function resolvePreparedExecEnvironment(params: {
  execParams: ExecToolArgs;
  host: ExecHost;
  sandbox?: BashSandboxConfig;
  containerWorkdir?: string | null;
  channelContext?: PluginHookChannelContext;
  subagentExecution?: boolean;
  defaultPathPrepend: string[];
  pluginEnv?: Record<string, string>;
  storeEnv?: Record<string, string>;
  storeSecretEnv?: Record<string, string>;
  credentialScrubEnv?: Readonly<Record<string, string>>;
  localIdentityEnv?: Readonly<Record<string, string>>;
  localGitConfigParameters?: string;
  managedLocalIdentity?: boolean;
  localProcessEnv?: Readonly<Record<string, string>>;
  warnings: string[];
}): {
  env: Record<string, string>;
  requestedEnv?: Record<string, string>;
  executionContext?: SystemRunExecutionContext;
} {
  if (params.localProcessEnv && params.host !== "gateway") {
    throw new Error(LOCAL_INSTALLATION_TARGET_UNSUPPORTED);
  }
  const inheritedBaseEnv = coerceEnv(process.env);
  const executionContext: SystemRunExecutionContext = {
    senderId: normalizeOptionalString(params.channelContext?.sender?.id),
    chatId: normalizeOptionalString(params.channelContext?.chat?.id),
    ...(params.subagentExecution ? { subagent: true } : {}),
  };
  const routingEnv = buildExecRoutingEnv(executionContext);
  const explicitEnv: Record<string, string> | undefined =
    params.execParams.env !== undefined || params.pluginEnv !== undefined
      ? { ...params.execParams.env, ...params.pluginEnv }
      : undefined;
  const storeEnvResult = params.storeEnv
    ? sanitizeHostExecEnvWithDiagnostics({
        baseEnv: {},
        overrides: params.storeEnv,
        blockPathOverrides: true,
      })
    : undefined;
  const { [OPENCLAW_CLI_ENV_VAR]: _storeMarker, ...acceptedStoreEnv } = storeEnvResult?.env ?? {};
  let storeEnv = Object.keys(acceptedStoreEnv).length > 0 ? acceptedStoreEnv : undefined;
  const rejectedStoreKeys = new Set([
    ...(storeEnvResult?.rejectedOverrideBlockedKeys ?? []),
    ...(storeEnvResult?.rejectedOverrideInvalidKeys ?? []),
  ]);
  if (params.storeEnv && Object.hasOwn(params.storeEnv, OPENCLAW_CLI_ENV_VAR)) {
    rejectedStoreKeys.add(OPENCLAW_CLI_ENV_VAR);
  }
  if (params.host === "sandbox" && storeEnv) {
    const sandboxStoreEnvResult = sanitizeEnvVars(storeEnv);
    storeEnv = sandboxStoreEnvResult.allowed;
    for (const key of sandboxStoreEnvResult.blocked) {
      rejectedStoreKeys.add(key);
    }
    if (sandboxStoreEnvResult.warnings.length > 0) {
      params.warnings.push(
        `Warning: secret store environment entries need attention: ${sandboxStoreEnvResult.warnings.join("; ")}.`,
      );
    }
  }
  if (rejectedStoreKeys.size > 0) {
    params.warnings.push(
      `Warning: secret store environment entries were not applied for host=${params.host}: ${Array.from(rejectedStoreKeys).toSorted().join(", ")}.`,
    );
  }
  const hasStoreEnv = storeEnv && Object.keys(storeEnv).length > 0;
  const untrustedRequestedEnv: Record<string, string> | undefined = hasStoreEnv
    ? { ...storeEnv, ...explicitEnv }
    : explicitEnv;
  const requestedEnv: Record<string, string> | undefined = params.storeSecretEnv
    ? { ...storeEnv, ...params.storeSecretEnv, ...explicitEnv }
    : untrustedRequestedEnv;
  const hostEnvResult =
    params.host === "sandbox"
      ? null
      : sanitizeHostExecEnvWithDiagnostics({
          baseEnv: inheritedBaseEnv,
          overrides: untrustedRequestedEnv,
          blockPathOverrides: true,
        });
  if (
    hostEnvResult &&
    untrustedRequestedEnv &&
    (hostEnvResult.rejectedOverrideBlockedKeys.length > 0 ||
      hostEnvResult.rejectedOverrideInvalidKeys.length > 0)
  ) {
    const blockedKeys = hostEnvResult.rejectedOverrideBlockedKeys;
    const invalidKeys = hostEnvResult.rejectedOverrideInvalidKeys;
    const pathBlocked = blockedKeys.includes("PATH");
    if (pathBlocked && blockedKeys.length === 1 && invalidKeys.length === 0) {
      throw new Error(
        "Security Violation: Custom 'PATH' variable is forbidden during host execution.",
      );
    }
    if (blockedKeys.length === 1 && invalidKeys.length === 0) {
      throw new Error(
        `Security Violation: Environment variable '${blockedKeys[0]}' is forbidden during host execution.`,
      );
    }
    const details: string[] = [];
    if (blockedKeys.length > 0) {
      details.push(`blocked override keys: ${blockedKeys.join(", ")}`);
    }
    if (invalidKeys.length > 0) {
      details.push(`invalid non-portable override keys: ${invalidKeys.join(", ")}`);
    }
    const suffix = details.join("; ");
    if (pathBlocked) {
      throw new Error(
        `Security Violation: Custom 'PATH' variable is forbidden during host execution (${suffix}).`,
      );
    }
    throw new Error(`Security Violation: ${suffix}.`);
  }

  const env =
    params.sandbox && params.host === "sandbox"
      ? buildSandboxEnv({
          defaultPath: DEFAULT_PATH,
          paramsEnv: untrustedRequestedEnv,
          sandboxEnv: params.sandbox.env,
          containerWorkdir: params.containerWorkdir ?? params.sandbox.containerWorkdir,
        })
      : (hostEnvResult?.env ?? inheritedBaseEnv);

  if (!params.sandbox && params.host === "gateway" && !requestedEnv?.PATH) {
    const shellPath = getShellPathFromLoginShell({
      env: process.env,
      timeoutMs: resolveShellEnvFallbackTimeoutMs(process.env),
    });
    applyShellPath(env, shellPath);
  }

  // `tools.exec.pathPrepend` is only meaningful when exec runs locally (gateway) or in the sandbox.
  // Node hosts intentionally ignore request-scoped PATH overrides, so don't pretend this applies.
  // The Gateway CLI shim is merged in automatically and only exists on the Gateway host.
  if (params.host === "node") {
    if (omitGatewayAgentCliPath(params.defaultPathPrepend).length > 0) {
      params.warnings.push(
        "Warning: tools.exec.pathPrepend is ignored for host=node. Configure PATH on the node host/service instead.",
      );
    }
  } else {
    applyPathPrepend(env, params.defaultPathPrepend);
  }

  if (params.host === "gateway" && params.managedLocalIdentity === false) {
    // Native GitHub identity is the explicit exception to the generic host-secret filter.
    // Exact service-owner scrubs below still win; non-local hosts receive neither value.
    for (const name of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
      const value = process.env[name];
      if (typeof value === "string") {
        env[name] = value;
      }
    }
  }
  if (params.storeSecretEnv) {
    // Secret-kind entries are authenticated ciphertext, not active credentials.
    // Inject them after ordinary env filtering so names such as GH_TOKEN remain usable.
    for (const [key, value] of Object.entries(params.storeSecretEnv)) {
      if (!explicitEnv || !Object.hasOwn(explicitEnv, key)) {
        env[key] = value;
      }
    }
  }
  const preparedEnv: Record<string, string> = {
    ...params.localProcessEnv,
    ...params.credentialScrubEnv,
    ...(params.host === "gateway" ? params.localIdentityEnv : undefined),
  };
  // Prepared values win locally; nodes sanitize their own base env and reject scrub override keys.
  let executionEnv = mergeProcessEnv([env, preparedEnv, routingEnv]);
  if (params.host === "gateway" && params.localGitConfigParameters) {
    // Apply policy to the composed local environment, never to forwarded request overrides.
    const inheritedGitConfigParameters =
      resolveEnvironmentValue(executionEnv, "GIT_CONFIG_PARAMETERS") ??
      resolveEnvironmentValue(env, "GIT_CONFIG_PARAMETERS");
    executionEnv = mergeProcessEnv([
      executionEnv,
      {
        GIT_CONFIG_PARAMETERS: [inheritedGitConfigParameters, params.localGitConfigParameters]
          .filter(Boolean)
          .join(" "),
      },
    ]);
  }
  const forwardedEnv =
    params.host === "node" || !routingEnv ? requestedEnv : { ...requestedEnv, ...routingEnv };

  return {
    env: executionEnv,
    ...(params.host === "node" && routingEnv ? { executionContext } : {}),
    ...(params.host !== "node" && Object.keys(preparedEnv).length > 0
      ? { requestedEnv: { ...forwardedEnv, ...preparedEnv } }
      : { requestedEnv: forwardedEnv }),
  };
}

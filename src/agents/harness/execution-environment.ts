import type { AgentRuntimeRestrictionErrorDetails } from "../../../packages/gateway-protocol/src/agent-runtime-restriction-error-details.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSessionEntry } from "../../config/sessions/session-accessor.sqlite-exact-read.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { resolveExecConfigState } from "../exec-defaults.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import { AgentHarnessPreflightError } from "./errors.js";
import type { AgentHarness } from "./types.js";

type ExecutionEnvironmentFacts = {
  sandboxed: boolean;
  sandboxRequired: boolean;
  workspaceOnly: boolean;
  permissionMode?: EmbeddedRunAttemptParams["permissionMode"];
  remoteExecution?: boolean;
  nativeRuntimeConsent?: string;
  toolPolicyRestricted?: boolean;
  workspaceRequired?: boolean;
};

type ExecutionRestriction = {
  reason: AgentRuntimeRestrictionErrorDetails["reason"];
  message: string;
};

/** Selection and invocation share this decision; a native working directory is not containment. */
export function resolveAgentHarnessExecutionRestriction(
  harness: Pick<AgentHarness, "id" | "label" | "executionEnvironment">,
  facts: ExecutionEnvironmentFacts,
): ExecutionRestriction | undefined {
  if (harness.executionEnvironment !== "host-only") {
    return undefined;
  }
  const label = harness.label;
  if (facts.sandboxRequired) {
    return {
      reason: "sandbox-required",
      message:
        label +
        " runs on the Gateway host, but this chat requires a sandbox. Choose another runtime; this requirement cannot be removed.",
    };
  }
  if (facts.remoteExecution) {
    return {
      reason: "remote-execution",
      message:
        label +
        " runs on the Gateway host and cannot use this chat's remote execution environment. Choose another runtime or a local chat.",
    };
  }
  if (facts.workspaceRequired) {
    return {
      reason: "workspace-only",
      message:
        label + " cannot enforce this run's required workspace boundary. Choose another runtime.",
    };
  }
  if (facts.nativeRuntimeConsent === harness.id) {
    return undefined;
  }
  if (facts.workspaceOnly) {
    return {
      reason: "workspace-only",
      message:
        label +
        " cannot enforce this chat's workspace-only file access. Choose another runtime or ask an administrator to review the file-access policy.",
    };
  }
  if (facts.sandboxed) {
    return {
      reason: "sandbox",
      message:
        label +
        " runs on the Gateway host, outside the sandbox. Use its own permissions for this chat, or choose another runtime.",
    };
  }
  if (facts.permissionMode && facts.permissionMode !== "full") {
    return {
      reason: "permission-mode",
      message:
        label +
        " uses its own permissions and requires Full access. Change this chat's permissions explicitly, or choose another runtime.",
    };
  }
  if (facts.toolPolicyRestricted) {
    return {
      reason: "tool-policy",
      message:
        label + " uses its own tools and cannot enforce this chat's OpenClaw tool restrictions.",
    };
  }
  return undefined;
}

type ExecutionEnvironmentParams = Pick<
  EmbeddedRunAttemptParams,
  | "config"
  | "agentId"
  | "sessionKey"
  | "sessionId"
  | "sandboxSessionKey"
  | "sandboxAgentId"
  | "sandbox"
  | "permissionMode"
  | "requireWorkspaceOnly"
  | "execOverrides"
  | "toolsAllow"
  | "disableTools"
  | "swarmCollector"
>;

/** Revalidates execution policy and returns whether this run has native permission consent. */
export function assertAgentHarnessExecutionEnvironment(
  harness: AgentHarness,
  params: ExecutionEnvironmentParams,
): boolean {
  if (harness.executionEnvironment !== "host-only") {
    return false;
  }
  const agentId = resolveSessionAgentId({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const entry = params.sessionKey
    ? resolveSessionEntry(
        {
          agentId,
          sessionKey: params.sessionKey,
          storePath: resolveSessionStorePathCore(params.config?.session?.store, { agentId }),
          clone: false,
        },
        { readOnly: true },
      ).existing
    : undefined;
  // Consent belongs to this incarnation, never a parent or classification session.
  const nativeRuntimeConsent =
    entry?.sessionId === params.sessionId &&
    entry.agentRuntimeOverride === harness.id &&
    entry.permissionMode === "full" &&
    entry.sandboxMode === "off" &&
    !params.disableTools &&
    params.toolsAllow === undefined &&
    !params.swarmCollector
      ? entry.nativeRuntimeConsent
      : undefined;
  const runtime = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    classificationSessionKey: params.sandboxSessionKey,
    classificationAgentId: params.sandboxAgentId,
    ...((!params.sandboxSessionKey || params.sandboxSessionKey === params.sessionKey) &&
    (!params.sandboxAgentId || params.sandboxAgentId === agentId)
      ? { preparedSessionEntry: entry ?? null }
      : {}),
  });
  const exec = resolveExecConfigState({
    cfg: params.config,
    agentId: runtime.classificationAgentId,
    sessionKey: params.sessionKey,
    execOverrides: params.execOverrides,
  });
  const restriction = resolveAgentHarnessExecutionRestriction(harness, {
    sandboxed: params.sandbox?.enabled === true || runtime.sandboxed || exec.host === "sandbox",
    nativeRuntimeConsent,
    workspaceRequired: params.requireWorkspaceOnly === true,
    sandboxRequired: runtime.sandboxRequired || exec.host === "sandbox",
    workspaceOnly:
      params.requireWorkspaceOnly === true ||
      resolveEffectiveToolFsWorkspaceOnly({
        cfg: params.config,
        agentId: runtime.classificationAgentId,
      }),
    permissionMode: params.permissionMode,
    remoteExecution: exec.host === "node",
  });
  if (restriction) {
    throw new AgentHarnessPreflightError(restriction.message, {
      scope: "harness",
      userMessage: restriction.message,
    });
  }
  return nativeRuntimeConsent === harness.id;
}

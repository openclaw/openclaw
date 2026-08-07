import { isExecutionIdentityCollectionEnabled } from "../audit/audit-config.js";
import {
  enqueueExecutionIdentityContextAtAdmission,
  getExecutionIdentityAdmissionScope,
  runWithExecutionIdentityAdmissionScope,
  runWithoutExecutionIdentityAdmissionScope,
  type ExecutionIdentityAdmissionFacts,
} from "../audit/execution-identity-admission.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureAgentRunLifecycleGeneration } from "../infra/agent-events.js";
import { reserveAgentRunAttribution } from "../infra/agent-run-registry.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createAgentExecutionAttribution,
  resolveAgentExecutionIdentityAdmission,
} from "./agent-execution-attribution.js";
import type { PreparedAgentCommandExecution } from "./command/prepare.js";
import type { AgentCommandGatewayIngressOpts, AgentCommandOpts } from "./command/types.js";

type AgentCommandAdmissionIngress = ExecutionIdentityAdmissionFacts["ingress"];

const LOCAL_CLI_ADMISSION_INGRESS: AgentCommandAdmissionIngress = {
  kind: "local-cli",
  boundary: "agent-command.local",
  state: "present",
};
const log = createSubsystemLogger("agents/agent-command");

function systemIngress(boundary: string): AgentCommandAdmissionIngress {
  return { kind: "system", boundary, state: "present" };
}

function recordAgentCommandExecutionIdentity(params: {
  agentId: string;
  cfg: OpenClawConfig;
  ingress: AgentCommandAdmissionIngress;
  runId: string;
  runtimeKind: ExecutionIdentityAdmissionFacts["runtime"]["kind"];
}): void {
  const admission = getExecutionIdentityAdmissionScope();
  if (!admission || !isExecutionIdentityCollectionEnabled(params.cfg)) {
    return;
  }
  // Session work admission owns these facts. Queue acceptance is not persistence;
  // audit loss must never become run loss.
  enqueueExecutionIdentityContextAtAdmission(
    {
      runId: params.runId,
      agentId: params.agentId,
      ingress: params.ingress,
      runtime: { kind: params.runtimeKind },
    },
    {
      enabled: true,
      token: admission.token,
      retryOnly: admission.retryOnly,
    },
  );
}

function resolveAgentCommandExecutionAttribution(
  opts: AgentCommandOpts,
  params: {
    runId: string;
    sessionKey?: string;
    sessionId?: string;
    sessionAgentId?: string;
  },
): {
  attribution: NonNullable<AgentCommandOpts["executionAttribution"]>;
  lifecycleGeneration: string;
} {
  if (opts.executionAttribution && opts.executionAttribution.runId !== params.runId) {
    throw new Error("Agent command execution attribution runId does not match the command runId.");
  }
  const lifecycleGeneration =
    opts.executionAttribution?.lifecycleGeneration ??
    opts.lifecycleGeneration ??
    captureAgentRunLifecycleGeneration(params.runId);
  const attribution =
    opts.executionAttribution ??
    createAgentExecutionAttribution({
      runId: params.runId,
      lifecycleGeneration,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      agentId: params.sessionAgentId,
    });
  return {
    attribution: reserveAgentRunAttribution(params.runId, lifecycleGeneration, attribution),
    lifecycleGeneration,
  };
}

function replaceAgentCommandExecutionAttribution(
  opts: AgentCommandOpts,
  attribution: AgentCommandOpts["executionAttribution"],
): AgentCommandOpts {
  return attribution === opts.executionAttribution
    ? opts
    : { ...opts, executionAttribution: attribution };
}

function prepareAgentCommandIngress(
  opts: AgentCommandGatewayIngressOpts,
  trustedAttribution: boolean,
): {
  lifecycleGeneration: string;
  opts: AgentCommandGatewayIngressOpts;
} {
  const internalOpts: AgentCommandGatewayIngressOpts = trustedAttribution
    ? opts
    : { ...opts, executionAttribution: undefined };
  if (typeof internalOpts.allowModelOverride !== "boolean") {
    throw new Error("allowModelOverride must be explicitly set for ingress agent runs.");
  }
  return {
    lifecycleGeneration:
      internalOpts.lifecycleGeneration ??
      captureAgentRunLifecycleGeneration(internalOpts.runId ?? ""),
    opts: internalOpts,
  };
}

async function runPreparedAgentCommandWithExecutionIdentity<TResult>(params: {
  prepared: PreparedAgentCommandExecution;
  run: (prepared: PreparedAgentCommandExecution) => Promise<TResult>;
}): Promise<TResult> {
  const resolved = resolveAgentCommandExecutionAttribution(params.prepared.opts, params.prepared);
  const resolvedOpts = replaceAgentCommandExecutionAttribution(
    params.prepared.opts,
    resolved.attribution,
  );
  const prepared =
    resolvedOpts === params.prepared.opts
      ? params.prepared
      : { ...params.prepared, opts: resolvedOpts };
  // Every prepared command is an independent admitted root. Detached A2A and
  // in-process child dispatch can begin inside a parent's async chain.
  return await runWithoutExecutionIdentityAdmissionScope(async () => {
    if (!isExecutionIdentityCollectionEnabled(prepared.cfg)) {
      return await params.run(prepared);
    }
    let scope: ReturnType<typeof resolveAgentExecutionIdentityAdmission> | undefined;
    try {
      const admission = resolveAgentExecutionIdentityAdmission(resolved.attribution);
      if (admission.token.runId !== prepared.runId) {
        throw new Error("execution identity admission token disagrees with the prepared run");
      }
      scope = admission;
    } catch (error) {
      // Correlation is audit evidence, not execution admission. Invalid public
      // run identifiers or stale private retry tokens must not become run loss.
      log.warn("execution identity unavailable; continuing agent run without correlation", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return scope
      ? await runWithExecutionIdentityAdmissionScope(scope, () => params.run(prepared))
      : await params.run(prepared);
  });
}

export const executionIdentity = {
  localIngress: LOCAL_CLI_ADMISSION_INGRESS,
  prepareIngress: prepareAgentCommandIngress,
  record: recordAgentCommandExecutionIdentity,
  replaceAttribution: replaceAgentCommandExecutionAttribution,
  resolveAttribution: resolveAgentCommandExecutionAttribution,
  runPrepared: runPreparedAgentCommandWithExecutionIdentity,
  systemIngress,
};

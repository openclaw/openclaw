import type { ExecutionIdentityAdmissionFacts } from "../audit/execution-identity-admission.js";
import { executionIdentitySpawnAdmission } from "../audit/execution-identity-spawn-admission.js";
import { withPostAdmissionExecutionOwnerBinding } from "../audit/execution-owner-binding.js";
import type { InternalSessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { drainAgentRunTerminalWrites } from "../infra/agent-run-terminal-writes.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type OperationalRunInstanceRef,
} from "./admitted-run-context.js";
import {
  attachAgentCommandAdmissionFacts,
  getAgentCommandAdmissionFacts,
} from "./agent-command-admission-facts.js";
import {
  type AgentCommandExecutionIdentitySpawnFacts,
  readAgentCommandExecutionIdentitySpawnFacts,
  withoutAgentCommandExecutionIdentitySpawnFacts,
} from "./agent-command-execution-identity-spawn.js";
import {
  AGENT_COMMAND_PUBLIC_INGRESS_DEFAULTS,
  type AgentCommandGatewayIngressOpts,
  type AgentCommandIngressOpts,
  type AgentCommandOpts,
} from "./command/types.js";

export type AgentCommandAdmissionIngress = ExecutionIdentityAdmissionFacts["ingress"];

const LOCAL_CLI_ADMISSION_INGRESS: AgentCommandAdmissionIngress = {
  kind: "local-cli",
  boundary: "agent-command.local",
  state: "present",
};

function systemIngress(boundary: string): AgentCommandAdmissionIngress {
  return { kind: "system", boundary, state: "present" };
}

function prepareAgentCommandRunAdmission(
  params: {
    agentId: string;
    cfg: OpenClawConfig;
    ingress: AgentCommandAdmissionIngress;
    operationalRunInstance: OperationalRunInstanceRef;
    runId: string;
    onAdmitted?: Parameters<typeof prepareAgentRunAdmission>[0]["onAdmitted"];
    assertSourceCurrent?: () => void;
    operatorAuthority?: AgentCommandOpts["operatorAuthority"];
  },
  spawnFacts?: AgentCommandExecutionIdentitySpawnFacts,
) {
  const admissionFacts = getAgentCommandAdmissionFacts(params.operationalRunInstance) ?? {
    ingress: params.ingress,
  };
  const applicableGrants = spawnFacts?.applicableGrants;
  const assurance = spawnFacts?.assurance ?? admissionFacts.assurance;
  const representedSubject = spawnFacts?.representedSubject ?? admissionFacts.representedSubject;
  return prepareAgentRunAdmission({
    cfg: params.cfg,
    operationalRunInstance: params.operationalRunInstance,
    facts: executionIdentitySpawnAdmission({
      operation: "attach",
      value: {
        runId: params.runId,
        agentId: params.agentId,
        ingress: spawnFacts?.ingress ?? admissionFacts.ingress,
        ...(representedSubject ? { representedSubject } : {}),
        ...((spawnFacts?.invoker ?? admissionFacts.invoker)
          ? { invoker: spawnFacts?.invoker ?? admissionFacts.invoker }
          : {}),
        ...(applicableGrants ? { applicableGrants } : {}),
        ...(assurance ? { assurance } : {}),
      },
      extra: spawnFacts?.spawnAdmission,
    }),
    ...(params.onAdmitted ? { onAdmitted: params.onAdmitted } : {}),
    assertSourceCurrent: params.assertSourceCurrent,
    operatorAuthority: params.operatorAuthority,
  });
}

export function prepareAgentCommandExecutionIdentity(params: {
  opts: AgentCommandOpts;
  prepared: {
    cfg: OpenClawConfig;
    runId: string;
    sessionAgentId: string;
    sessionId: string;
    sessionKey?: string;
    sessionEntry?: InternalSessionEntry;
    storePath?: string;
  };
  ingress: AgentCommandAdmissionIngress;
  lifecycleGeneration: string;
}) {
  const { opts, prepared } = params;
  const operationalRunInstance =
    opts.operationalRunInstance ?? createOperationalRunInstanceRef(prepared.runId);
  const admissionFacts = getAgentCommandAdmissionFacts(params.opts.runContext ?? params.opts);
  if (admissionFacts) {
    attachAgentCommandAdmissionFacts(operationalRunInstance, admissionFacts);
  }
  const admissionParams: Parameters<typeof prepareAgentCommandRunAdmission>[0] = {
    agentId: prepared.sessionAgentId,
    cfg: prepared.cfg,
    ingress: params.ingress,
    operationalRunInstance,
    runId: prepared.runId,
    assertSourceCurrent: opts.assertSourceCurrent,
    operatorAuthority: opts.operatorAuthority,
    onAdmitted: opts.onAdmittedRunContext,
  };
  const spawnFacts = readAgentCommandExecutionIdentitySpawnFacts(opts);
  const preparedAdmission = spawnFacts
    ? prepareAgentCommandRunAdmission(admissionParams, spawnFacts)
    : executionIdentity.prepare(admissionParams);
  const admission = opts.onPostAdmittedRunContext
    ? withPostAdmissionExecutionOwnerBinding(preparedAdmission, opts.onPostAdmittedRunContext)
    : preparedAdmission;
  return Object.freeze({
    ...admission,
    finalDeliverySource: prepared.sessionEntry
      ? {
          sessionId: prepared.sessionEntry.sessionId,
          lifecycleRevision: prepared.sessionEntry.lifecycleRevision,
          activeWriterRunId: prepared.sessionEntry.activeWriterRunId,
        }
      : undefined,
    finish: async () => {
      await drainAgentRunTerminalWrites(admission.operationalRunInstance).finally(admission.close);
    },
  });
}

export function sanitizePublicAgentCommandIngressOpts(
  opts: AgentCommandIngressOpts,
): AgentCommandGatewayIngressOpts {
  return withoutAgentCommandExecutionIdentitySpawnFacts({
    ...opts,
    ...AGENT_COMMAND_PUBLIC_INGRESS_DEFAULTS,
  });
}

export const executionIdentity = {
  localIngress: LOCAL_CLI_ADMISSION_INGRESS,
  prepare: prepareAgentCommandRunAdmission,
  systemIngress,
};

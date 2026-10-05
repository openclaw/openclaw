import {
  assertOperatorModelAllowed,
  readRunOperatorAuthority,
  resolvePreparedRunAdmission,
} from "../admitted-run-context.js";
import { isAdmittedRunForegroundOnly } from "../run-execution-policy.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import type { RunCliAgentParams } from "./types.js";

/** Keep the logical model ceiling across CLI transport mapping and asynchronous preparation. */
export function prepareCliRunModelAuthority(params: RunCliAgentParams): RunCliAgentParams {
  const operatorAuthority = readRunOperatorAuthority(params);
  const execution = resolveSandboxRuntimeStatus({
    cfg: params.config,
    agentId: params.agentId,
    sessionKey: params.runtimePolicySessionKey ?? params.sessionKey,
    preparedSessionEntry: params.sessionEntry,
  }).execution;
  if (
    execution === "foreground-only" ||
    operatorAuthority?.rolePolicy?.execution === "foreground-only" ||
    isAdmittedRunForegroundOnly(params.admittedRunContext)
  ) {
    throw new Error(
      "CLI runtimes cannot join this chat's foreground container cleanup. Choose the OpenClaw embedded runtime with a local Docker or Podman sandbox.",
    );
  }
  const model = params.requesterModel;
  assertOperatorModelAllowed(operatorAuthority, model);
  if (!operatorAuthority) {
    return params;
  }
  const assertCallerCurrent = params.assertCurrent;
  return {
    ...params,
    assertCurrent: () => {
      assertCallerCurrent?.();
      assertOperatorModelAllowed(operatorAuthority, model);
    },
  };
}

export async function admitCliRunParams(
  candidate: RunCliAgentParams,
  agentId: string,
): Promise<
  RunCliAgentParams & { admittedRunContext: NonNullable<RunCliAgentParams["admittedRunContext"]> }
> {
  const admittedRunContext = await resolvePreparedRunAdmission({
    runId: candidate.runId,
    runtimeKind: "embedded",
    admittedRunContext: candidate.admittedRunContext,
    preparedRunAdmission: candidate.preparedRunAdmission,
  });
  candidate.assertCurrent?.();
  const { preparedRunAdmission: _preparedRunAdmission, ...rest } = candidate;
  return { ...rest, agentId, admittedRunContext };
}

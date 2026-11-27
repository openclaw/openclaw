import {
  assertOperatorModelAllowed,
  readRunOperatorAuthority,
  resolvePreparedRunAdmission,
} from "../admitted-run-context.js";
import type { RunCliAgentParams } from "./types.js";

/** Keep the logical model ceiling across CLI transport mapping and asynchronous preparation. */
export function prepareCliRunModelAuthority(params: RunCliAgentParams): RunCliAgentParams {
  const operatorAuthority = readRunOperatorAuthority(params);
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

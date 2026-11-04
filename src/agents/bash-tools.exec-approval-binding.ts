import {
  revalidateSystemRunMutableFileBinding,
  type SystemRunMutableFileBinding,
} from "../infra/system-run-approval-binding.js";
import {
  APPROVAL_CWD_DRIFT_DENIED_MESSAGE,
  revalidateApprovedCwdSnapshot,
  type ApprovedCwdSnapshot,
} from "../infra/system-run-cwd-binding.js";
import { buildGatewayExecApprovalDeniedToolResult } from "./bash-tools.exec-host-gateway.output.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { AgentToolResult } from "./runtime/index.js";

export async function resolveGatewayExecApprovalDrift(params: {
  binding?: SystemRunMutableFileBinding;
  cwdSnapshot?: ApprovedCwdSnapshot;
  cwd: string;
}): Promise<string | undefined> {
  if (params.binding) {
    const current = await revalidateSystemRunMutableFileBinding({
      binding: params.binding,
      cwd: params.cwd,
    });
    if (!current.ok) {
      return current.message;
    }
  }
  if (params.cwdSnapshot && !revalidateApprovedCwdSnapshot(params.cwdSnapshot)) {
    return APPROVAL_CWD_DRIFT_DENIED_MESSAGE;
  }
  return undefined;
}

/** Rechecks a gateway approval binding at the caller's final spawn boundary. */
export async function revalidateGatewayExecApprovalBinding(params: {
  binding?: SystemRunMutableFileBinding;
  cwdSnapshot?: ApprovedCwdSnapshot;
  command: string;
  cwd: string;
}): Promise<AgentToolResult<ExecToolDetails> | undefined> {
  const deniedReason = await resolveGatewayExecApprovalDrift(params);
  return deniedReason
    ? buildGatewayExecApprovalDeniedToolResult({
        deniedReason,
        command: params.command,
        cwd: params.cwd,
      })
    : undefined;
}

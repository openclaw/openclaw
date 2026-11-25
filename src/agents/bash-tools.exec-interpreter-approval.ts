/** Interpreter program facts that Gateway exec approval turns into asks. Never refusals. */
import {
  describeInterpreterInlineEval,
  type InterpreterInlineEvalHit,
} from "../infra/command-analysis/inline-eval.js";
import {
  detectInlineEvalInSegments,
  detectOpaqueInterpreterProgram,
} from "../infra/command-analysis/risks.js";
import type { ExecAllowlistAnalysis } from "../infra/exec-approvals-allowlist.js";
import type { ExecAsk, ExecSecurity } from "../infra/exec-approvals-core.js";
import { prepareSystemRunMutableFileBinding } from "../infra/system-run-approval-binding.js";
import type { ProcessGatewayAllowlistParams } from "./bash-tools.exec-host-gateway.types.js";

/** Strict inline-eval mode asks for every inline interpreter payload. */
export function inlineEvalFact(
  params: ProcessGatewayAllowlistParams,
  analysis: ExecAllowlistAnalysis,
): InterpreterInlineEvalHit | null {
  const hit =
    params.strictInlineEval === true ? detectInlineEvalInSegments(analysis.segments) : null;
  if (hit) {
    params.warnings.push(
      `Warning: strict inline-eval mode requires reviewer or explicit approval for ${describeInterpreterInlineEval(hit)}.`,
    );
  }
  return hit;
}

/**
 * An opaque program is an allowlist miss only where the policy asks a reviewer or a person,
 * and only when approval can bind the command. Otherwise the current policy decides.
 */
export async function opaqueProgramAsk(
  params: ProcessGatewayAllowlistParams,
  analysis: ExecAllowlistAnalysis,
  security: ExecSecurity,
  ask: ExecAsk,
): Promise<boolean> {
  if (
    security !== "allowlist" ||
    ask !== "on-miss" ||
    !analysis.analysisOk ||
    (params.nonInteractiveApproval === true && params.autoReview !== true) ||
    !detectOpaqueInterpreterProgram(params.command, analysis.segments).opaque
  ) {
    return false;
  }
  const binding = await prepareSystemRunMutableFileBinding({
    command: { kind: "segments", segments: analysis.segments },
    cwd: params.workdir,
    env: params.env,
  });
  return binding.ok;
}

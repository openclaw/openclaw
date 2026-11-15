import { isSessionBindingError } from "../../../infra/outbound/session-binding-errors.js";
import { summarizeSpawnError, type runSpawnPipeline } from "../../spawn-pipeline.js";

export type SpawnAcpMode = "run" | "session";

type SpawnAcpErrorCode =
  | "acp_disabled"
  | "requester_session_required"
  | "runtime_policy"
  | "resume_forbidden"
  | "subagent_policy"
  | "thread_required"
  | "target_agent_required"
  | "runtime_agent_mismatch"
  | "agent_forbidden"
  | "cwd_resolution_failed"
  | "thread_binding_invalid"
  | "spawn_failed"
  | "dispatch_failed";

type SpawnAcpResultFields = {
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  runTimeoutSeconds?: number;
  expectsCompletionMessage?: boolean;
  inlineDelivery?: boolean;
  note?: string;
};

export type SpawnAcpResult =
  | (SpawnAcpResultFields & {
      status: "accepted";
      childSessionKey: string;
      runId: string;
      mode: SpawnAcpMode;
    })
  | (SpawnAcpResultFields & {
      status: "forbidden" | "error";
      error: string;
      errorCode: SpawnAcpErrorCode;
    });

export function buildAcpSpawnError(
  errorCode: SpawnAcpErrorCode,
  error: string,
  status: "error" | "forbidden" = "error",
) {
  return { status, errorCode, error };
}

export function buildAcpSpawnFailureResult(
  result: Extract<Awaited<ReturnType<typeof runSpawnPipeline>>, { ok: false }>,
  childSessionKey: string,
): SpawnAcpResult {
  const { phase, error, runId } = result;
  const bindingError = phase === "initialize" && isSessionBindingError(error);
  return {
    status: "error",
    errorCode: bindingError
      ? "thread_binding_invalid"
      : phase === "dispatch"
        ? "dispatch_failed"
        : "spawn_failed",
    error: bindingError
      ? error.message
      : phase === "register"
        ? `Failed to register ACP run: ${summarizeSpawnError(error)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`
        : summarizeSpawnError(error),
    ...(phase !== "initialize" ? { childSessionKey } : {}),
    ...(phase === "register" && runId ? { runId } : {}),
  };
}

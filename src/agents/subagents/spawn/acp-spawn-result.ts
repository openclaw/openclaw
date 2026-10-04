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

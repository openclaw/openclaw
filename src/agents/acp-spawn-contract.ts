export const ACP_SPAWN_MODES = ["run", "session"] as const;
export type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];

export const ACP_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnAcpSandboxMode = (typeof ACP_SPAWN_SANDBOX_MODES)[number];

export const ACP_SPAWN_STREAM_TARGETS = ["parent"] as const;
export type SpawnAcpStreamTarget = (typeof ACP_SPAWN_STREAM_TARGETS)[number];

export type SpawnAcpParams = {
  task: string;
  label?: string;
  agentId?: string;
  resumeSessionId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: SpawnAcpSandboxMode;
  streamTo?: SpawnAcpStreamTarget;
};

export type SpawnAcpContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  /** Group chat ID for channels that distinguish group vs. topic (for example Telegram). */
  agentGroupId?: string;
  /** Group space label (guild/team id) from the originating channel context. */
  agentGroupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  agentMemberRoleIds?: string[];
  sandboxed?: boolean;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
};

export const ACP_SPAWN_ERROR_CODES = [
  "acp_disabled",
  "requester_session_required",
  "runtime_policy",
  "resume_forbidden",
  "subagent_policy",
  "thread_required",
  "target_agent_required",
  "runtime_agent_mismatch",
  "agent_forbidden",
  "cwd_resolution_failed",
  "thread_binding_invalid",
  "spawn_failed",
  "dispatch_failed",
] as const;
export type SpawnAcpErrorCode = (typeof ACP_SPAWN_ERROR_CODES)[number];

type SpawnAcpResultFields = {
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  inlineDelivery?: boolean;
  streamLogPath?: string;
  note?: string;
};

export type SpawnAcpAcceptedResult = SpawnAcpResultFields & {
  status: "accepted";
  childSessionKey: string;
  runId: string;
  mode: SpawnAcpMode;
};

export type SpawnAcpFailedResult = SpawnAcpResultFields & {
  status: "forbidden" | "error";
  error: string;
  errorCode: SpawnAcpErrorCode;
};

export type SpawnAcpResult = SpawnAcpAcceptedResult | SpawnAcpFailedResult;

export function isSpawnAcpAcceptedResult(result: SpawnAcpResult): result is SpawnAcpAcceptedResult {
  return result.status === "accepted";
}

export const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";

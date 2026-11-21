/** Identifies a run transcript target without naming the current storage artifact. */
export type AgentRunSessionTarget = {
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  threadId?: string | number;
  /** Internal admission fence paired with sessionId for run-owned transcript writes. */
  expectedLifecycleRevision?: string;
  /** Internal durable writer claim installed after session-lane admission. */
  expectedWriterRunId?: string;
};

export type BoundAgentRunSessionTarget = Required<
  Pick<AgentRunSessionTarget, "agentId" | "sessionId" | "sessionKey" | "storePath">
> &
  Pick<AgentRunSessionTarget, "expectedLifecycleRevision" | "expectedWriterRunId">;

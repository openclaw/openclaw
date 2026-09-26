import type { AgentWaitResult } from "../../run-wait.types.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

export type FollowupReply = AgentWaitResult & { replyText?: string };
type FollowupCustody = {
  run<T>(work: () => T): T;
  assertCurrent(): void;
  signal: AbortSignal;
  release(): void;
};
export type FollowupRequest = {
  runId: string;
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterAgentId: string;
  targetSessionKey: string;
  targetAgentId: string;
  custody: FollowupCustody;
  completion?: FollowupCompletionOwner;
};
export type FollowupCohort = { entries: readonly SubagentRunRecord[]; generation: number };
export type FollowupSuccessor = {
  owner: FollowupCompletionOwner;
  cohort: FollowupCohort;
  runId: string;
  assertCurrent(): void;
};

export type FollowupSettlement = { kind: "yielded" } | { kind: "terminal"; reply: FollowupReply };
/** Logical result custody outlives each physical execution and its projections. */
export interface FollowupCompletionOwner {
  readonly request: FollowupRequest;
  readonly signal: AbortSignal;
  readonly accepted: boolean;
  assertCurrent(): void;
  markAccepted(runId: string): void;
  finishExecution(runId: string): void;
  ownsExecution(runId: string): boolean;
  assertExecutionCurrent(runId: string): void;
  promoteYield(runId: string, entries: readonly SubagentRunRecord[], generation: number): void;
  successor(
    entries: readonly SubagentRunRecord[],
    runId: string,
    assertCurrent: () => void,
  ): FollowupSuccessor;
  prepareSuccessor(successor: FollowupSuccessor): Promise<void>;
  adopt(successor: FollowupSuccessor): void;
  settle(
    runId: string,
    reply: FollowupReply,
    assertCurrent?: () => void,
  ): Promise<FollowupSettlement>;
  take(timeoutMs?: number): Promise<FollowupReply | undefined>;
  replaceCohortEntry(previous: SubagentRunRecord, next: SubagentRunRecord): () => void;
  close(error?: unknown): void;
}

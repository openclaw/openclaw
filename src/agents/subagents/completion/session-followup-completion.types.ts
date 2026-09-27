import type { Result } from "@openclaw/normalization-core/result";
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
export type FollowupCancellation =
  | { kind: "settled" }
  | {
      kind: "terminal";
      runId: string;
      reply: FollowupReply;
      /** Guard the pending projection write without revoking an already committed result. */
      assertCurrent: () => void;
    };
export type FollowupExecution = {
  assertCurrent(): void;
  cancel?: (reason: string, assertCallerCurrent: () => void) => Promise<Result<void, string>>;
};

/** Logical result custody outlives each physical execution and its projections. */
export interface FollowupCompletionOwner {
  readonly request: FollowupRequest;
  readonly signal: AbortSignal;
  readonly accepted: boolean;
  assertCurrent(): void;
  markAccepted(runId: string): void;
  finishExecution(runId: string): void;
  ownsExecution(runId: string): boolean;
  activate(runId: string, execution: FollowupExecution): Promise<() => void>;
  cancel(
    reason: string,
    assertCallerCurrent: () => void,
  ): Promise<Result<FollowupCancellation, string>>;
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

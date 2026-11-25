import type { ThinkLevel } from "../auto-reply/thinking.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AdmittedRunOperatorAuthority } from "./admitted-run-context.js";
import type { AgentHarnessIsolatedCompletionParamsV2 } from "./harness/types.js";
import type { IsolatedCompletionPurpose } from "./isolated-completion-purpose.js";

export type RunIsolatedCompletionParams = {
  purpose?: IsolatedCompletionPurpose;
  sessionId?: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  provider: string;
  model: string;
  /** Explicit credential owner. CLI and harness paths must not replace it with another profile. */
  authProfileId?: string;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  /** Concrete owner already resolved by the caller, when available. */
  agentHarnessRuntimeOverride?: string;
  systemPrompt: string;
  prompt: string;
  timeoutMs: number;
  /** Adapt the owner's deadline reason to the caller's error contract. */
  timeoutError?: Error;
  abortSignal?: AbortSignal;
  /** Private credential directories must remain outside the configured Gateway owner. */
  preparedModelRuntimeMode?: "isolated-read-only";
  /** Duration of dispatch through the selected runtime, excluding model/auth preparation. */
  onRequestComplete?: (durationMs: number) => void;
  /** Revalidate the caller's authority before credential handoff and dispatch. */
  assertCurrent?: () => void;
  /** Explicit requester restriction; automatic metadata callers remain system-owned. */
  operatorAuthority?: AdmittedRunOperatorAuthority;
  /** Adapt host authorization failures to the calling completion API's error contract. */
  mapOperatorAuthorizationError?: (error: unknown) => Error;
  thinkLevel?: ThinkLevel;
  outputSchema?: AgentHarnessIsolatedCompletionParamsV2["outputSchema"];
  outputTextPolicy?: AgentHarnessIsolatedCompletionParamsV2["outputTextPolicy"];
  /** Internal answer budget; reasoning reserves still obey model and explicit stream limits. */
  answerTokenBudget?: number;
  streamParams?: AgentHarnessIsolatedCompletionParamsV2["streamParams"];
};

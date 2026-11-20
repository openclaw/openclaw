import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import { getCliSessionBinding } from "../config/sessions/cli-session-binding.js";
import type { CliSessionBinding, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import type { PreparedAgentRunAdmission } from "./admitted-run-context.js";
import { cliBackendSupportsSessionFork } from "./cli-backends.js";
import type { EmbeddedAgentRunResult } from "./embedded-agent-runner/types.js";
import type { SessionForkRequester } from "./session-fork-requester.js";
import type { SessionManager } from "./sessions/session-manager.js";

/** Where a fork of a CLI-runtime session branches: the anchored turn's native reply. */
export type CliSessionForkAnchor = {
  provider: string;
  binding: CliSessionBinding;
  /** Native checkpoint of the anchored turn's final reply. */
  resumeAt: string;
};

/**
 * The native session and checkpoint of the anchored turn's CLI reply. The CLI keeps the
 * conversation in its own session, so a fork can only branch at a reply a native session recorded.
 * It resumes that reply's own session, which the CLI keeps after the source moves to a successor;
 * the account and cwd checks use the source's current binding. Anything else fails before any CLI
 * or provider I/O.
 */
export function resolveCliSessionForkAnchor(params: {
  config: OpenClawConfig;
  provider: string;
  sessionManager: SessionManager;
  entry: SessionEntry | undefined;
}): CliSessionForkAnchor {
  const { provider } = params;
  if (!cliBackendSupportsSessionFork(provider, params.config)) {
    throw new Error(
      `Session forks are not supported for CLI runtime ${provider}: it cannot branch a native session.`,
    );
  }
  const last = params.sessionManager
    .getBranch()
    .findLast((entry) => entry.type === "message")?.message;
  const meta =
    last?.role === "assistant" ? asOptionalRecord(Reflect.get(last, "__openclaw")) : undefined;
  const cliSessionId = typeof meta?.cliSessionId === "string" ? meta.cliSessionId : "";
  const resumeAt = typeof meta?.externalId === "string" ? meta.externalId : "";
  if (!cliSessionId || !resumeAt) {
    throw new Error(
      `Session forks on CLI runtime ${provider} branch at a ${provider} reply recorded in the transcript; the anchored turn has none (it is still running, its reply went out through the message tool, or it ran on another runtime). Fork through a turn with a recorded reply.`,
    );
  }
  const binding = getCliSessionBinding(params.entry, provider);
  if (!binding) {
    throw new Error(
      `Session forks on CLI runtime ${provider} need the session's ${provider} binding; it has none. Send a turn on ${provider}, then fork again.`,
    );
  }
  return { provider, binding: { ...binding, sessionId: cliSessionId }, resumeAt };
}

/**
 * Runs a session fork on the source session's CLI backend: a fresh CLI process resumes the
 * anchored native session with the backend's fork argument at the anchored reply. The Gateway's
 * MCP grant lists the session's tools, so the native session keeps its catalog, and runs only the
 * fork's own; native CLI tools stay off. The successor session is kept nowhere.
 * The source transcript, the source's native session and its binding stay unchanged.
 */
export async function runCliSessionFork(params: {
  anchor: CliSessionForkAnchor;
  config: OpenClawConfig;
  agentId: string;
  agentDir: string;
  /** The source session: tool policy, sandbox and inherited restrictions follow it. */
  sourceSessionKey: string;
  sourceEntry: SessionEntry | undefined;
  forkSession: { sessionId: string; sessionKey: string };
  /** The fork's in-memory view of the source conversation; hooks read history from it. */
  sessionManager: SessionManager;
  preparedRunAdmission: PreparedAgentRunAdmission;
  workspaceDir: string;
  /** The cwd the source session's turns ran the CLI in; its native session lives there. */
  cwd?: string;
  prompt: string;
  model: { provider: string; model: string; authProfileId?: string };
  /** Tools the fork may run; the grant still lists every session tool. */
  toolCallsAllow: string[];
  requester?: SessionForkRequester;
  conversation: { messageChannel?: string; messageProvider?: string; agentAccountId?: string };
  inputProvenance: InputProvenance;
  runId: string;
  lane: string;
  timeoutMs: number;
  thinkLevel: ThinkLevel | undefined;
  abortSignal: AbortSignal;
}): Promise<EmbeddedAgentRunResult> {
  const { runCliAgent } = await import("./cli-runner.runtime.js");
  const { anchor } = params;
  // Same per-owner lane as an embedded fork: forks of one plugin run one at a time.
  return await enqueueCommandInLane(
    params.lane,
    () =>
      runCliAgent({
        preparedRunAdmission: params.preparedRunAdmission,
        agentId: params.agentId,
        agentDir: params.agentDir,
        config: params.config,
        sessionId: params.forkSession.sessionId,
        sessionKey: params.forkSession.sessionKey,
        sessionFile: params.forkSession.sessionKey,
        sessionManager: params.sessionManager,
        runtimePolicySessionKey: params.sourceSessionKey,
        ...(params.sourceEntry ? { sessionEntry: params.sourceEntry } : {}),
        ...params.conversation,
        ...params.requester,
        inputProvenance: params.inputProvenance,
        workspaceDir: params.workspaceDir,
        ...(params.cwd ? { cwd: params.cwd } : {}),
        prompt: params.prompt,
        provider: anchor.provider,
        modelProvider: params.model.provider,
        model: params.model.model,
        requesterModel: { provider: params.model.provider, model: params.model.model },
        ...(params.model.authProfileId ? { authProfileId: params.model.authProfileId } : {}),
        thinkLevel: params.thinkLevel,
        runId: params.runId,
        lane: params.lane,
        timeoutMs: params.timeoutMs,
        runTimeoutOverrideMs: params.timeoutMs,
        abortSignal: params.abortSignal,
        controlOperation: "fork",
        cliSessionId: anchor.binding.sessionId,
        cliSessionBinding: anchor.binding,
        forkCliSessionOnResume: true,
        cliSessionResumeAt: anchor.resumeAt,
        toolCallsAllow: params.toolCallsAllow,
        // A fresh process, so the fork argument applies and no warm child is left behind.
        disableCliLiveSession: true,
        cleanupCliLiveSessionOnRunEnd: true,
        runtimeFactsInTurn: true,
        requireExplicitMessageTarget: true,
        disableTrajectory: true,
        allowEmptyAssistantReplyAsSilent: true,
        terminalReplyExpectation: "optional",
      }),
    { abortSignal: params.abortSignal },
  );
}

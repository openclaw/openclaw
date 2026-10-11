import {
  AgentHarnessPreflightError,
  embeddedAgentLog,
  formatErrorMessage,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexEphemeralThreadPolicy } from "./client-thread-owner.js";
import {
  isCodexAppServerOverloadError,
  isCodexAppServerPrewriteRequestCancellationError,
  type CodexAppServerClient,
} from "./client.js";
import { assertCodexThreadAcceptsDirectInput } from "./protocol-validators.js";
import type { CodexThread } from "./protocol.js";
import {
  CodexAppServerScopedRequestRejectedError,
  requestCodexAppServerClientJson,
} from "./request.js";
import type { CodexAppServerThreadBinding } from "./session-binding.js";
import { CodexAdoptedThreadActiveError } from "./thread-lifecycle-errors.js";
import type { CodexThreadLifecycleTimingTracker } from "./thread-lifecycle-timing.js";
import type { CodexStartOrResumeThreadParams } from "./thread-lifecycle-types.js";

/** A refusal, not a failed native write: the ephemeral conversation must stay alive. */
export class CodexIncognitoPolicyChangeError extends AgentHarnessPreflightError {
  constructor() {
    super(
      "Codex cannot change generic instructions in a live incognito conversation. No turn was sent and the conversation is preserved. Restore the previous instructions to continue it, or start a new incognito conversation for the changed policy.",
    );
    this.name = "CodexIncognitoPolicyChangeError";
  }
}

type CodexPolicyHandoffPhase =
  | "subscription-release"
  | "native-unload"
  | "tool-attestation"
  | "policy-write"
  | "binding-commit";

const handoffPhaseMessages: Record<CodexPolicyHandoffPhase, string> = {
  "subscription-release": "Codex could not confirm releasing this session's subscription",
  "native-unload": "Codex did not confirm unloading its previous configuration",
  "tool-attestation": "Codex could not confirm this session's current tool policy",
  "policy-write": "Codex could not complete this session's policy write",
  "binding-commit": "Codex could not commit this session's policy binding",
};

/** Never replay a handoff: native persistence can precede an unsuccessful RPC response. */
export class CodexThreadPolicyHandoffError extends AgentHarnessPreflightError {
  constructor(
    readonly outcome: "not-written" | "unknown" | "acknowledged",
    cause: unknown,
    readonly phase: CodexPolicyHandoffPhase = "policy-write",
  ) {
    const message = `${handoffPhaseMessages[phase]}. ${
      outcome === "unknown" ? "The policy write outcome is unknown and will not be replayed. " : ""
    }The conversation is preserved; reconnect this session before retrying.`;
    super(message, { cause, userMessage: message });
    this.name = "CodexThreadPolicyHandoffError";
  }
}

type CodexThreadHandoffParams = {
  client: CodexAppServerClient;
  threadId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Warm reuse proves ownership before writing; an in-turn restore already holds it. */
  assertCurrent?: () => void;
  withCurrent?: (write: () => void) => Promise<void>;
};

/** The complete body remains generic configuration for compaction and native child inheritance. */
export async function refreshCodexThreadPolicy(
  params: CodexThreadHandoffParams & { developerInstructions: string },
): Promise<void> {
  const notice =
    "The following is the complete current OpenClaw-supplied generic instruction policy. It replaces earlier OpenClaw-supplied generic policy, including sections removed from that generic policy. Parent-local instructions supplied for the current inference request are outside this policy replacement. Independently supplied native managed, guardian, security, collaboration, and project instructions retain their authority. User requests retain their own authority.\n\n";
  const text =
    notice +
    (params.developerInstructions === ""
      ? "The current OpenClaw generic policy is empty; earlier OpenClaw generic policy is withdrawn."
      : params.developerInstructions);
  await injectCodexThreadDeveloperHandoff(params, text);
}

/**
 * Refreshes skills, persona, and memory instructions on a live thread whose generic policy cannot
 * change (ephemeral threads have no resume source). The refresh is a client-authored
 * developer message, so it must be re-delivered after every compaction.
 */
export async function refreshCodexThreadInstructions(
  params: CodexThreadHandoffParams & { refreshableInstructions: string | undefined },
): Promise<void> {
  const notice =
    "The following is the complete current OpenClaw refreshable thread instructions. It replaces earlier OpenClaw-supplied skills, persona, and memory instructions in this conversation.\n\n";
  const text =
    notice +
    (params.refreshableInstructions ??
      "The current OpenClaw refreshable thread instructions are empty; earlier OpenClaw-supplied skills, persona, and memory instructions are withdrawn.");
  await injectCodexThreadDeveloperHandoff(params, text);
}

/**
 * Compaction rebuilds initial context from the thread's creation-time developer
 * instructions and can drop client-authored developer messages (including local
 * compaction regardless of `retain_client_developer_messages`). Restore the current
 * section for subsequent requests. The immediate native continuation can still
 * precede this handoff and see creation-time instructions.
 */
export async function restoreCodexThreadInstructionsAfterCompaction(
  params: CodexThreadHandoffParams & { ephemeralPolicy: CodexEphemeralThreadPolicy | undefined },
): Promise<CodexEphemeralThreadPolicy | undefined> {
  const policy = params.ephemeralPolicy;
  if (!policy || policy.refreshableInstructions === policy.nativeRefreshableInstructions) {
    return policy;
  }
  try {
    await refreshCodexThreadInstructions({
      ...params,
      refreshableInstructions: policy.refreshableInstructions,
    });
    return policy;
  } catch (error) {
    embeddedAgentLog.warn("failed to restore Codex thread instructions after compaction", {
      threadId: params.threadId,
      error: formatErrorMessage(error),
    });
    // Record what compaction restored so the next turn retries the lost handoff.
    return { ...policy, refreshableInstructions: policy.nativeRefreshableInstructions };
  }
}

async function injectCodexThreadDeveloperHandoff(
  params: CodexThreadHandoffParams,
  text: string,
): Promise<void> {
  let outcome: CodexThreadPolicyHandoffError["outcome"] = "unknown";
  try {
    await requestCodexAppServerClientJson({
      ...params,
      method: "thread/inject_items",
      requestParams: {
        threadId: params.threadId,
        items: [{ type: "message", role: "developer", content: [{ type: "input_text", text }] }],
      },
    });
    outcome = "acknowledged";
    if (params.withCurrent) {
      await params.withCurrent(() => params.assertCurrent?.());
    } else {
      params.assertCurrent?.();
    }
    params.signal?.throwIfAborted();
  } catch (cause) {
    if (
      outcome !== "acknowledged" &&
      (cause instanceof CodexAppServerScopedRequestRejectedError ||
        isCodexAppServerPrewriteRequestCancellationError(cause) ||
        isCodexAppServerOverloadError(cause))
    ) {
      outcome = "not-written";
    }
    throw new CodexThreadPolicyHandoffError(outcome, cause);
  }
}

/** Native lineage classifies the exact bound thread; it never grants session authority. */
export function assertCodexSupervisionThreadLineage(
  binding: CodexAppServerThreadBinding,
  thread: CodexThread,
): void {
  if (binding.connectionScope !== "supervision" || binding.pendingSupervisionBranch) {
    return;
  }
  if (
    thread.id !== binding.threadId ||
    !binding.supervisionSourceThreadId ||
    (thread.forkedFromId !== null &&
      (typeof thread.forkedFromId !== "string" ||
        !thread.forkedFromId.trim() ||
        thread.forkedFromId === thread.id))
  ) {
    throw new Error(
      "Codex supervision lineage could not be verified; reconnect before continuing.",
    );
  }
}

/** Passive refusal must precede releasing or acquiring any native subscription. */
export async function assertAdoptedCodexThreadResumeAllowed(
  params: CodexStartOrResumeThreadParams,
  threadId: string,
  context: {
    lifecycleTiming: Pick<CodexThreadLifecycleTimingTracker, "measure">;
    throwIfAborted: () => void;
  },
  assertCurrent: () => void,
): Promise<CodexThread> {
  const { thread } = await context.lifecycleTiming.measure("thread-read-adoption-status", () =>
    params.client.request(
      "thread/read",
      { threadId, includeTurns: false },
      { signal: params.signal, assertCurrent, withCurrent: params.authority?.withCurrent },
    ),
  );
  context.throwIfAborted();
  if (thread.id !== threadId) {
    throw new Error("Codex returned another thread during adoption status read");
  }
  assertCodexThreadAcceptsDirectInput(thread);
  if (thread.status?.type === "active") {
    throw new CodexAdoptedThreadActiveError();
  }
  return thread;
}

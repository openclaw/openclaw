/**
 * Pi Agent runtime — wraps `runEmbeddedPiAgent` behind the AgentRuntime interface.
 *
 * The factory function captures all Pi-specific parameters at construction time
 * (messaging context, model auth, tool policies, sandbox config, etc.) so the
 * caller only needs to pass the common `AgentRuntimeRunParams` at run time.
 */

import type { AgentRuntime, AgentRuntimeRunParams, AgentRuntimeResult } from "./agent-runtime.js";
import type { RunEmbeddedPiAgentParams } from "./pi-embedded-runner/run/params.js";
import { runEmbeddedPiAgent } from "./pi-embedded.js";

// ---------------------------------------------------------------------------
// Pi-specific context (everything NOT in AgentRuntimeRunParams)
// ---------------------------------------------------------------------------

/**
 * All the Pi Agent fields that are NOT part of the common AgentRuntimeRunParams.
 * These are captured once at factory creation time and merged with the common
 * params on each `run()` call.
 */
export type PiRuntimeContext = Omit<
  RunEmbeddedPiAgentParams,
  | "sessionId"
  | "sessionKey"
  | "sessionFile"
  | "workspaceDir"
  | "agentDir"
  | "config"
  | "prompt"
  | "extraSystemPrompt"
  | "ownerNumbers"
  | "timeoutMs"
  | "runId"
  | "abortSignal"
  | "onPartialReply"
  | "onAssistantMessageStart"
  | "onBlockReply"
  | "onToolResult"
  | "onAgentEvent"
>;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a Pi Agent runtime instance.
 *
 * @param context - Pi-specific parameters (messaging, model auth, sandbox, etc.)
 * @returns An `AgentRuntime` that delegates to `runEmbeddedPiAgent`.
 */
export function createPiAgentRuntime(context: PiRuntimeContext): AgentRuntime {
  return {
    kind: "pi",
    displayName: "Pi Agent",
    async run(params: AgentRuntimeRunParams): Promise<AgentRuntimeResult> {
      return runEmbeddedPiAgent({
        ...context,
        ...params,
      });
    },
  };
}

export function splitRunEmbeddedPiAgentParamsForRuntime(params: RunEmbeddedPiAgentParams): {
  context: PiRuntimeContext;
  run: AgentRuntimeRunParams;
} {
  const {
    sessionId,
    sessionKey,
    sessionFile,
    workspaceDir,
    agentDir,
    config,
    prompt,
    extraSystemPrompt,
    ownerNumbers,
    timeoutMs,
    runId,
    abortSignal,
    onPartialReply,
    onAssistantMessageStart,
    onBlockReply,
    onToolResult,
    onAgentEvent,
    ...context
  } = params;

  return {
    context: context as PiRuntimeContext,
    run: {
      sessionId,
      sessionKey,
      sessionFile,
      workspaceDir,
      agentDir,
      config,
      prompt,
      extraSystemPrompt,
      ownerNumbers,
      timeoutMs,
      runId,
      abortSignal,
      onPartialReply,
      onAssistantMessageStart,
      onBlockReply,
      onToolResult,
      onAgentEvent,
    },
  };
}

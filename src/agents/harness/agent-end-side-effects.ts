/**
 * Agent-end side effect runner.
 *
 * Harnesses use this to trigger core research capture and plugin agent_end hooks.
 * Fire-and-forget callers keep auto-capture opportunistic.
 */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runSkillResearchAutoCapture } from "../../skills/research/autocapture.js";
import {
  awaitAgentHarnessAgentEndHook,
  runAgentHarnessAgentEndHook,
} from "./lifecycle-hook-helpers.js";

const log = createSubsystemLogger("agents/harness");

type AgentEndSideEffectsParams = Parameters<typeof runAgentHarnessAgentEndHook>[0];

function startSkillResearchAutoCapture(params: AgentEndSideEffectsParams): Promise<void> {
  return runSkillResearchAutoCapture({
    event: params.event,
    ctx: params.ctx,
    ...(params.ctx.config ? { config: params.ctx.config } : {}),
  }).catch((error: unknown) => {
    log.warn(`skill research auto-capture failed: ${String(error)}`);
  });
}

/** Starts agent-end side effects without waiting for completion. */
export function runAgentEndSideEffects(params: AgentEndSideEffectsParams): void {
  void startSkillResearchAutoCapture(params);
  runAgentHarnessAgentEndHook(params);
}

/** Runs agent-end side effects and waits for completion. */
export async function awaitAgentEndSideEffects(params: AgentEndSideEffectsParams): Promise<void> {
  const captureSettled = startSkillResearchAutoCapture(params);
  const hookSettled = awaitAgentHarnessAgentEndHook(params);
  await Promise.all([captureSettled, hookSettled]);
}

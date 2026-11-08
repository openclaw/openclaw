import type { TurnOutcome } from "@muse-code/sdk";
import { emitAgentHarnessAttemptEvent } from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import {
  embeddedAgentLog,
  type AgentHarnessAttemptParamsV2,
  type AgentHarnessAttemptResult,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

export async function observeMuseViewCompleteness({
  incomplete,
  params,
  outcome,
  interrupted,
  logger,
  assertCurrent,
}: {
  incomplete: boolean;
  params: AgentHarnessAttemptParamsV2;
  outcome: TurnOutcome;
  interrupted: boolean;
  logger: Pick<PluginLogger, "warn"> | undefined;
  assertCurrent: () => void;
}): Promise<void> {
  if (
    incomplete &&
    !interrupted &&
    outcome.kind === "completed" &&
    outcome.params.terminal === "completed"
  ) {
    assertCurrent();
    const message =
      "Muse finished this turn, but OpenClaw could not recover part of its activity history. Some tool activity may be missing. Verify the task's result before repeating it.";
    logger?.warn(message);
    await emitAgentHarnessAttemptEvent(
      params,
      { stream: "notice", data: { phase: "warning", message } },
      { label: "Muse", log: embeddedAgentLog },
    );
  }
}

export function museReplayMetadata({
  incomplete,
  failure,
  initialReplayState,
  toolCount,
}: {
  incomplete: boolean;
  failure: unknown;
  initialReplayState: AgentHarnessAttemptParamsV2["initialReplayState"];
  toolCount: number;
}): AgentHarnessAttemptResult["replayMetadata"] {
  return {
    replaySafe: !incomplete && !failure && !initialReplayState?.replayInvalid && toolCount === 0,
    hadPotentialSideEffects:
      incomplete || initialReplayState?.hadPotentialSideEffects === true || toolCount > 0,
  };
}

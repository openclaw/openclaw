import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { hashCliSessionText } from "../cli-session.js";
import type { RunCliAgentParams } from "./types.js";

export async function prepareCliChildInstructions({
  params,
  runConfig,
  sessionAgentId,
  skipsTurnPreparation,
}: {
  params: RunCliAgentParams;
  runConfig: OpenClawConfig;
  sessionAgentId: string;
  skipsTurnPreparation: boolean;
}) {
  let extraSystemPrompt = params.extraSystemPrompt?.trim() ?? "";
  const childSessionKey = params.sessionKey;
  if (
    !skipsTurnPreparation &&
    !params.isolatedCompletion &&
    childSessionKey &&
    isSubagentSessionKey(childSessionKey)
  ) {
    const [
      { buildSubagentStandingInstructions },
      { getSubagentDepthFromSessionStoreInWorker, getSubagentSpawnModeFromSessionStoreInWorker },
      { getLatestSubagentRunByChildSessionKey },
    ] = await Promise.all([
      import("../subagents/spawn/subagent-system-prompt.js"),
      import("../subagents/spawn/subagent-depth.js"),
      import("../subagents/registry/subagent-registry-read.js"),
    ]);
    const [childDepth, storedMode, recordedRun] = await Promise.all([
      params.sessionEntry?.spawnDepth ??
        getSubagentDepthFromSessionStoreInWorker(childSessionKey, {
          cfg: runConfig,
          agentId: sessionAgentId,
        }),
      params.sessionEntry?.spawnMode ??
        getSubagentSpawnModeFromSessionStoreInWorker(childSessionKey, {
          cfg: runConfig,
          agentId: sessionAgentId,
        }),
      getLatestSubagentRunByChildSessionKey(childSessionKey, sessionAgentId),
    ]);
    const standingInstructions = buildSubagentStandingInstructions({
      childDepth,
      maxSpawnDepth: runConfig.agents?.defaults?.subagents?.maxSpawnDepth,
      // The spawned entry owns mode; older entries fall back to the retained run record.
      spawnMode:
        storedMode ??
        recordedRun?.spawnMode ??
        (params.cleanupBundleMcpOnRunEnd === false ? "session" : "run"),
    }).trim();
    // Spawn already supplies this prefix; continuations reconstruct it from session facts.
    if (
      extraSystemPrompt === standingInstructions ||
      extraSystemPrompt.startsWith(`${standingInstructions}\n\n`)
    ) {
      extraSystemPrompt = extraSystemPrompt.slice(standingInstructions.length).trimStart();
    }
    extraSystemPrompt = [standingInstructions, extraSystemPrompt].filter(Boolean).join("\n\n");
  }
  const bindingExtraSystemPromptStatic =
    params.cliSessionBindingFacts?.extraSystemPromptStatic ?? params.extraSystemPromptStatic;
  const baseExtraSystemPromptHash =
    bindingExtraSystemPromptStatic !== undefined
      ? hashCliSessionText(bindingExtraSystemPromptStatic.trim() || undefined)
      : hashCliSessionText(extraSystemPrompt);
  return { extraSystemPrompt, baseExtraSystemPromptHash };
}

import { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { AgentRuntimePlan } from "../../runtime-plan/types.js";
import { CODEX_HARNESS_ID, resolveAttemptTrajectoryAttribution } from "./runtime-resolution.js";
import { projectTrajectorySessionTarget } from "./shared-run-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function prepareEmbeddedHarnessTrajectory(input: {
  attempt: Pick<
    EmbeddedRunAttemptParams,
    "config" | "runId" | "disableTrajectory" | "sessionPersistence"
  >;
  harnessId: string;
  model: { api?: string; provider?: string };
  modelId: string;
  provider: string;
  runtimePlan: AgentRuntimePlan;
  sessionId: string;
  sessionKey?: string;
  sessionFile: string;
  sessionTarget?: EmbeddedRunAttemptParams["sessionTarget"];
  workspaceDir: string;
}) {
  const { attempt } = input;
  const attribution = resolveAttemptTrajectoryAttribution(input);
  if (
    input.harnessId !== CODEX_HARNESS_ID ||
    attempt.disableTrajectory ||
    attempt.sessionPersistence === "detached"
  ) {
    return undefined;
  }
  return await createTrajectoryRuntimeRecorder({
    cfg: attempt.config,
    env: process.env,
    runId: attempt.runId,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    sessionFile: input.sessionFile,
    ...projectTrajectorySessionTarget(input.sessionTarget, true),
    provider: attribution.provider,
    modelId: attribution.modelId,
    modelApi: attribution.modelApi,
    workspaceDir: input.workspaceDir,
  });
}

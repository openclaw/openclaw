import { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import type { resolveAttemptTrajectoryAttribution } from "./runtime-resolution.js";

type TrajectoryAttribution = ReturnType<typeof resolveAttemptTrajectoryAttribution>;
type RecorderOptions = Parameters<typeof createTrajectoryRuntimeRecorder>[0];

export function createAttemptTrajectoryRecorder(input: {
  enabled: boolean;
  cfg: RecorderOptions["cfg"];
  runId: RecorderOptions["runId"];
  sessionId: RecorderOptions["sessionId"];
  sessionKey: RecorderOptions["sessionKey"];
  sessionFile: RecorderOptions["sessionFile"];
  sessionTarget?: RecorderOptions["sessionTarget"];
  attribution: TrajectoryAttribution;
  workspaceDir: RecorderOptions["workspaceDir"];
}) {
  if (!input.enabled) {
    return undefined;
  }
  return createTrajectoryRuntimeRecorder({
    cfg: input.cfg,
    env: process.env,
    runId: input.runId,
    sessionId: input.sessionId,
    sessionKey: input.sessionKey,
    sessionFile: input.sessionFile,
    ...(input.sessionTarget ? { sessionTarget: input.sessionTarget } : {}),
    provider: input.attribution.provider,
    modelId: input.attribution.modelId,
    modelApi: input.attribution.modelApi,
    workspaceDir: input.workspaceDir,
  });
}

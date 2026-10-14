import type { OwnedSessionTranscriptWriteContext } from "../../../config/sessions/transcript-write-context.js";
import type { SessionSystemPromptReport } from "../../../config/sessions/types.js";
import { buildTrajectoryRunMetadata } from "../../../trajectory/metadata.js";
import { createTrajectoryRuntimeRecorder } from "../../../trajectory/runtime.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import type { AgentSession } from "../../sessions/index.js";
import { resolveAttemptTrajectorySessionFile } from "./attempt-transcript-helpers.js";
import { projectTrajectorySessionTarget } from "./shared-run-context.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export async function prepareEmbeddedAttemptTrajectory(input: {
  activeSession: Pick<AgentSession, "sessionId">;
  transcriptOwner?: Pick<
    OwnedSessionTranscriptWriteContext,
    "sessionTarget" | "assertCommitAllowed" | "initialWriter"
  >;
  attempt: EmbeddedRunAttemptParams;
  clientToolCount: number;
  effectiveToolCount: number;
  effectiveWorkspace: string;
  localModelLeanEnabled: boolean;
  sessionAgentId: string;
  systemPromptReport?: SessionSystemPromptReport;
}): Promise<Awaited<ReturnType<typeof createTrajectoryRuntimeRecorder>>> {
  const { activeSession, attempt } = input;
  const candidate = input.transcriptOwner?.sessionTarget;
  const sessionKey = candidate?.sessionKey;
  const assertCommitAllowed = input.transcriptOwner?.assertCommitAllowed;
  const initialWriter = input.transcriptOwner?.initialWriter;
  // Reuse only the lock owner's descriptive key; recorder persistence retains its own authority.
  const retained =
    candidate &&
    sessionKey &&
    assertCommitAllowed &&
    candidate.agentId === input.sessionAgentId &&
    candidate.sessionId === activeSession.sessionId &&
    sessionKey === attempt.sessionKey &&
    candidate.storePath &&
    candidate.storePath === attempt.sessionTarget?.storePath
      ? {
          sessionKey,
          assertCurrent() {
            assertCommitAllowed();
            initialWriter?.assertActive();
          },
        }
      : undefined;
  retained?.assertCurrent();
  const trajectorySessionFile = retained
    ? retained.sessionKey
    : await resolveAttemptTrajectorySessionFile({
        agentId: input.sessionAgentId,
        config: attempt.config,
        sessionFile: attempt.sessionFile,
        sessionId: activeSession.sessionId,
        sessionKey: attempt.sessionKey,
        sessionTarget: attempt.sessionTarget,
      });
  if (attempt.disableTrajectory || attempt.sessionPersistence === "detached") {
    return null;
  }
  const assertActive = resolveAdmittedRunActiveAssertion(
    attempt.admittedRunContext,
    attempt.abortSignal,
  );
  if (!assertActive) {
    throw new Error("trajectory preparation requires an active admitted run");
  }
  assertActive();
  retained?.assertCurrent();
  const { sessionTarget } = projectTrajectorySessionTarget(attempt.sessionTarget);
  const recorder = await createTrajectoryRuntimeRecorder({
    cfg: attempt.config,
    env: process.env,
    runId: attempt.runId,
    sessionId: activeSession.sessionId,
    sessionKey: attempt.sessionKey,
    sessionFile: trajectorySessionFile,
    sessionTarget,
    provider: attempt.provider,
    modelId: attempt.modelId,
    modelApi: attempt.model.api,
    workspaceDir: attempt.workspaceDir,
  });
  assertActive();
  retained?.assertCurrent();
  recorder?.recordEvent("session.started", {
    trigger: attempt.trigger,
    sessionFile: attempt.sessionFile,
    workspaceDir: input.effectiveWorkspace,
    agentId: input.sessionAgentId,
    messageProvider: attempt.messageProvider,
    messageChannel: attempt.messageChannel,
    localModelLean: input.localModelLeanEnabled,
    toolCount: input.effectiveToolCount,
    clientToolCount: input.clientToolCount,
  });
  const fastMode = typeof attempt.fastMode === "boolean" ? attempt.fastMode : undefined;
  recorder?.recordEvent(
    "trace.metadata",
    buildTrajectoryRunMetadata({
      env: process.env,
      config: attempt.config,
      ...(attempt.preparedModelRuntime?.metadataSnapshot
        ? { pluginMetadataSnapshot: attempt.preparedModelRuntime.metadataSnapshot }
        : {}),
      workspaceDir: input.effectiveWorkspace,
      sessionFile: attempt.sessionFile,
      sessionKey: attempt.sessionKey,
      agentId: input.sessionAgentId,
      trigger: attempt.trigger,
      messageProvider: attempt.messageProvider,
      messageChannel: attempt.messageChannel,
      provider: attempt.provider,
      modelId: attempt.modelId,
      modelApi: attempt.model.api,
      timeoutMs: attempt.timeoutMs,
      fastMode,
      thinkLevel: attempt.thinkLevel,
      reasoningLevel: attempt.reasoningLevel,
      toolResultFormat: attempt.toolResultFormat,
      disableTools: attempt.disableTools,
      toolsAllow: attempt.toolsAllow,
      skillsSnapshot: attempt.skillsSnapshot,
      systemPromptReport: input.systemPromptReport,
    }),
  );
  return recorder;
}

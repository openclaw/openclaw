import {
  createRuntimeConfigReader,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSnapshotMetadata,
} from "../../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { ToolOutcomeObservation } from "../../agent-tools.before-tool-call.js";
import { isDecisionAssistanceEligible } from "../../decision-assistance.js";
import { resolveDecisionModelSetting } from "../../decision-model-setting.js";
import { createSemanticNoProgressObserver } from "../../semantic-no-progress.js";
import { resolveToolLoopDetectionConfig } from "../../tool-loop-detection-config.js";
import {
  createPostCompactionLoopGuard,
  PostCompactionLoopPersistedError,
} from "../post-compaction-loop-guard.js";
import { createTerminalToolPresentationTracker } from "./terminal-resolution.js";
import { createAgentTurnTaintState } from "./turn-taint-state.js";

/** Run-owned outcome state shared by every retry attempt, closed by the run owner. */
export function createRunToolOutcomeState({
  config,
  agentId,
  signal,
  laneTaskAbortController,
  assertAdmittedActive,
  goal,
  initialTurnTainted,
}: {
  config?: OpenClawConfig;
  agentId: string;
  signal: AbortSignal;
  laneTaskAbortController: AbortController;
  assertAdmittedActive?: () => void;
  goal: string;
  initialTurnTainted?: boolean;
}) {
  // Post-compaction loop guard for #77474. Armed at each compaction-success
  // site below; observed from the live tool-outcome path so it can abort
  // while the post-compaction prompt is still running.
  const resolvedLoopDetectionConfig = resolveToolLoopDetectionConfig({
    cfg: config,
    agentId,
  });
  const postCompactionGuard = createPostCompactionLoopGuard({
    enabled: resolvedLoopDetectionConfig?.enabled !== false,
  });
  const preparedSemanticMode = resolvedLoopDetectionConfig?.semanticNoProgress;
  const preparedDecisionModel = config ? resolveDecisionModelSetting(config, agentId) : undefined;
  const readConfig = createRuntimeConfigReader(config ?? {});
  // Any publication may have briefly revoked consent between observer reads.
  // A scoped config is not owned by the global runtime snapshot.
  const preparedRuntimeRevision =
    readConfig() === getRuntimeConfigSnapshot()
      ? getRuntimeConfigSnapshotMetadata()?.revision
      : undefined;
  const isEligible = () => {
    const currentConfig = readConfig();
    const currentLoopConfig = resolveToolLoopDetectionConfig({ cfg: currentConfig, agentId });
    const currentDecisionModel = resolveDecisionModelSetting(currentConfig, agentId);
    return (
      (preparedRuntimeRevision === undefined ||
        getRuntimeConfigSnapshotMetadata()?.revision === preparedRuntimeRevision) &&
      currentLoopConfig?.enabled === true &&
      currentLoopConfig.semanticNoProgress === preparedSemanticMode &&
      isDecisionAssistanceEligible(currentConfig, agentId) &&
      currentDecisionModel?.provider === preparedDecisionModel?.provider &&
      currentDecisionModel?.model === preparedDecisionModel?.model
    );
  };
  const semanticNoProgressObserver =
    resolvedLoopDetectionConfig?.enabled === true &&
    (resolvedLoopDetectionConfig.semanticNoProgress === "shadow" ||
      resolvedLoopDetectionConfig.semanticNoProgress === "replan") &&
    Boolean(config && isDecisionAssistanceEligible(config, agentId)) &&
    Boolean(assertAdmittedActive)
      ? createSemanticNoProgressObserver({
          signal,
          isEligible,
          assertActive: () => {
            signal.throwIfAborted();
            if (!assertAdmittedActive) {
              throw new Error("embedded run requires an active admitted run");
            }
            assertAdmittedActive();
          },
          agentId,
          goal,
        })
      : undefined;
  let postCompactionAbortController: AbortController | undefined;
  let postCompactionAbortError: PostCompactionLoopPersistedError | undefined;
  // Presentation survives retry attempts, but a newer tool result must clear stale text.
  const terminalToolPresentation = createTerminalToolPresentationTracker();
  const turnTaintState = createAgentTurnTaintState(initialTurnTainted === true);
  const observeToolOutcome = (observation: ToolOutcomeObservation): void => {
    terminalToolPresentation.observe(observation);
    turnTaintState.observe(observation);
    if (observation.presentationOnly) {
      return;
    }
    const verdict = postCompactionGuard.observe(observation);
    if (verdict.shouldAbort) {
      postCompactionAbortError ??= PostCompactionLoopPersistedError.fromVerdict(verdict);
      laneTaskAbortController.abort(postCompactionAbortError);
      postCompactionAbortController?.abort(postCompactionAbortError);
    }
  };
  return {
    resolvedLoopDetectionConfig,
    postCompactionGuard,
    semanticNoProgressObserver,
    terminalToolPresentation,
    turnTaintState,
    observeToolOutcome,
    getPostCompactionAbortError: () => postCompactionAbortError,
    setPostCompactionAbortController: (controller: AbortController | undefined) => {
      postCompactionAbortController = controller;
    },
    clearPostCompactionAbortController: (controller: AbortController) => {
      if (postCompactionAbortController === controller) {
        postCompactionAbortController = undefined;
      }
    },
  };
}

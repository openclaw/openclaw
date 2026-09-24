import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

/** Capture original input and policy before the plugin confirms actual execution placement. */
export function bindHarnessInputAttachments(params: {
  attempt: Partial<EmbeddedRunAttemptParams>;
  config?: OpenClawConfig;
  assertActive: () => void;
}) {
  const { attempt, config, assertActive } = params;
  const attemptSignal = attempt.abortSignal;
  const inputWorkspaceDir = attempt.workspaceDir;
  const inputTimeoutMs = attempt.timeoutMs;
  const initialInput = {
    media: structuredClone(attempt.inputAttachmentMedia ?? attempt.media),
    userTurnTranscriptRecorder: attempt.userTurnTranscriptRecorder,
  };
  const inputPolicyEligible =
    !attempt.sandbox?.enabled &&
    !attempt.requireWorkspaceOnly &&
    !attempt.modelRun &&
    attempt.promptMode !== "none" &&
    (!attempt.permissionMode || attempt.permissionMode === "full") &&
    !resolveEffectiveToolFsWorkspaceOnly({ cfg: config, agentId: attempt.agentId });
  // Selection supplies its already-resolved policy before handing the capability to the plugin.
  let inputReadAllowed = false;
  const prepareInputAttachments: AgentHarnessHostCapabilities["prepareInputAttachments"] =
    inputWorkspaceDir && inputTimeoutMs !== undefined
      ? async (request) => {
          const assertCurrent = () => {
            assertActive();
            attemptSignal?.throwIfAborted();
            request.signal?.throwIfAborted();
            request.assertCurrent();
          };
          assertCurrent();
          if (!inputReadAllowed || !inputPolicyEligible) {
            return undefined;
          }
          const { prepareAgentWorkspaceAttachments } = await import("../workspace-access.js");
          assertCurrent();
          const result = await prepareAgentWorkspaceAttachments({
            workspaceDir: inputWorkspaceDir,
            localExecution: { config, readAllowed: inputReadAllowed, maxChars: request.maxChars },
            turn: {
              ...(request.turn ?? initialInput),
              config,
              timeoutMs: inputTimeoutMs,
              abortSignal: request.signal ?? attemptSignal,
            },
            assertCurrent,
          });
          assertCurrent();
          return result;
        }
      : undefined;
  return {
    prepareInputAttachments,
    setInputAttachmentReadAllowed: (allowed: boolean) => {
      assertActive();
      inputReadAllowed = allowed;
    },
  };
}

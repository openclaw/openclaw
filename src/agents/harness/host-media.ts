import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readPersistedMediaFacts } from "../../media/media-facts.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { resolveEffectiveToolFsWorkspaceOnly } from "../tool-fs-policy.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { bindHarnessReplyMedia } from "./reply-media.js";

/** Bind media capabilities to the same captured attempt policy and host lifetime. */
export function bindHarnessMedia(params: {
  attempt: Partial<EmbeddedRunAttemptParams>;
  config?: OpenClawConfig;
  assertActive: () => void;
  signal: AbortSignal;
}) {
  const { attempt, config, assertActive } = params;
  const attemptSignal = attempt.abortSignal;
  const inputWorkspaceDir = attempt.workspaceDir;
  const inputTimeoutMs = attempt.timeoutMs;
  const initialInput = {
    media: structuredClone(attempt.inputAttachmentMedia ?? attempt.media),
    userTurnTranscriptRecorder: attempt.userTurnTranscriptRecorder,
  };
  const resolveInputAttachmentMedia = async () => {
    assertActive();
    attemptSignal?.throwIfAborted();
    const recorder = initialInput.userTurnTranscriptRecorder;
    const message = (await recorder?.resolveMessage()) ?? recorder?.message;
    assertActive();
    attemptSignal?.throwIfAborted();
    const media = structuredClone(
      (message ? readPersistedMediaFacts(message) : undefined) ?? initialInput.media ?? [],
    );
    return Object.freeze(media.map((fact) => Object.freeze(fact)));
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
  let prepareContextMedia: AgentHarnessHostCapabilities["prepareContextMedia"];
  if (attempt.workspaceDir && attempt.model) {
    const contextMedia = {
      config,
      workspaceDir: attempt.sandbox?.enabled ? attempt.sandbox.workspaceDir : attempt.workspaceDir,
      agentWorkspaceDir: attempt.workspaceDir,
      modelInput: attempt.model.input,
      agentId: attempt.agentId,
      sessionKey: attempt.sessionKey,
      sessionId: attempt.sessionId,
      channelId: attempt.messageChannel ?? attempt.messageProvider,
      accountId: attempt.agentAccountId,
      ...(attempt.sandbox?.enabled && attempt.sandbox.fsBridge
        ? {
            sandbox: {
              root: attempt.sandbox.workspaceDir,
              bridge: attempt.sandbox.fsBridge,
            },
          }
        : {}),
    };
    const assertCurrent = () => {
      assertActive();
      attempt.abortSignal?.throwIfAborted();
    };
    prepareContextMedia = async (request) => {
      assertCurrent();
      const { prepareHarnessContextMedia } = await import("./context-media-runtime.js");
      assertCurrent();
      const result = await prepareHarnessContextMedia({
        ...request,
        ...contextMedia,
        assertCurrent,
        signal: attemptSignal,
      });
      assertCurrent();
      return result;
    };
  }
  const prepareReplyMedia = bindHarnessReplyMedia(params);
  return {
    capabilities: {
      resolveInputAttachmentMedia,
      ...(prepareContextMedia ? { prepareContextMedia } : {}),
      ...(prepareInputAttachments ? { prepareInputAttachments } : {}),
      ...(prepareReplyMedia ? { prepareReplyMedia } : {}),
    },
    setInputAttachmentReadAllowed: (allowed: boolean) => {
      assertActive();
      inputReadAllowed = allowed;
    },
  };
}

import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { narrowSessionEventSettings } from "../../auto-reply/reply/session-event-policy.js";
import { intersectSessionEventToolsAllow } from "../../auto-reply/reply/session-event-target.js";
import { captureReplyMessageJoinObservation } from "../../sessions/session-controller.message-join-observation.js";
import { readSessionControllerOperationState } from "../../sessions/session-controller.state.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import {
  readAdmittedRunOperatorAuthority,
  readPreparedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import {
  createAgentQuestionAnswerAuthority,
  prepareReplyToolAuthorityCallerRead,
} from "../harness/host-private-capabilities.js";
import type { PreparedCliRunContext, RunCliAgentParams } from "./types.js";

/** Capture the original CLI caller before native tool availability replaces its tool cap. */
function prepareCliReplyToolAuthority(
  params: RunCliAgentParams,
  workspace: { agentId: string; workspaceDir: string; cwd: string },
) {
  return prepareReplyToolAuthority(
    {
      originatingChannel: normalizeMessageChannel(params.messageChannel),
      toolsAllow: params.toolsAllow,
      disableTools: params.disableTools,
      operatorAuthority:
        readAdmittedRunOperatorAuthority(params.admittedRunContext) ??
        readPreparedRunOperatorAuthority(params.preparedRunAdmission),
      run: {
        sessionId: params.sessionId,
        sessionFile: params.sessionFile,
        sessionKey: params.sessionKey,
        runtimePolicySessionKey: params.runtimePolicySessionKey,
        config: params.config,
        agentDir: params.agentDir,
        agentAccountId: params.agentAccountId,
        operatorProfileId: params.operatorProfileId,
        messageProvider: params.messageProvider,
        requesterOrigin: params.requesterOrigin,
        conversationId: params.conversationId,
        conversationToolPolicy: params.conversationToolPolicy,
        senderIsOwner: params.senderIsOwner,
        gitContributorProfileId: params.gitContributorProfileId,
        inputProvenance: params.inputProvenance,
        trustedInternalHandoff: params.trustedInternalHandoff,
        scheduledToolPolicy: params.scheduledToolPolicy,
        execOverrides: params.execOverrides,
        bashElevated: params.bashElevated,
        approvalReviewerDeviceId: params.approvalReviewerDeviceId,
        authProfileId: params.authProfileId,
        clientCaps: params.clientCaps,
        gatewayUiCommandTarget: params.gatewayUiCommandTarget,
        agentId: workspace.agentId,
        chatType: params.chatType ?? params.sessionEntry?.chatType,
        provider: params.modelProvider ?? params.provider,
        model: params.model ?? "default",
        workspaceDir: workspace.workspaceDir,
        cwd: workspace.cwd,
        permissionMode: params.sessionEntry?.permissionMode,
        toolOverrides: params.toolOverrides ?? params.sessionEntry?.toolOverrides,
        senderId: params.senderId ?? undefined,
        senderName: params.senderName ?? undefined,
        senderUsername: params.senderUsername ?? undefined,
        senderE164: params.senderE164 ?? undefined,
        groupId: params.groupId ?? undefined,
        groupChannel: params.groupChannel ?? undefined,
        groupSpace: params.groupSpace ?? undefined,
        spawnedBy: params.spawnedBy ?? undefined,
      },
    },
    undefined,
    undefined,
    captureReplyMessageJoinObservation({
      run: {
        ...workspace,
        config: params.config,
        agentDir: params.agentDir,
        sessionFile: params.sessionFile,
        authProfileId: params.authProfileId,
      },
      sessionEntry: params.sessionEntry,
    }),
  );
}

/** Keep creator facts together while backend preparation translates the run's tool policy. */
export function captureCliRunToolAuthority(
  params: RunCliAgentParams,
  workspace: Parameters<typeof prepareCliReplyToolAuthority>[1],
) {
  const directOperation =
    readSessionControllerOperationState(params.replyOperation)?.turnKind === "direct" &&
    params.trigger !== "memory" &&
    !params.controlOperation
      ? params.replyOperation
      : undefined;
  let operation =
    params.toolAuthorityFingerprint || directOperation?.toolAuthorityFingerprint
      ? params.replyOperation
      : undefined;
  const snapshot = operation ? undefined : prepareCliReplyToolAuthority(params, workspace);
  let snapshotTransferred = false;
  const sessionKey = params.sessionKey ?? params.sessionId;
  const signal = params.abortSignal;
  const assertSourceCurrent = params.assertCurrent;
  const sourcePolicy = captureCliSessionEventSourcePolicy(params);
  return {
    [Symbol.dispose]() {
      if (!snapshotTransferred) {
        snapshot?.close();
      }
    },
    finalizeSessionEventSourcePolicy(run: RunCliAgentParams, promptToolsAllow?: readonly string[]) {
      return Object.freeze({
        ...sourcePolicy,
        toolsAllow: intersectSessionEventToolsAllow(
          sourcePolicy.toolsAllow,
          promptToolsAllow,
          run.disableTools
            ? []
            : run.cliToolAvailability?.native.length === 0
              ? run.cliToolAvailability.openClaw
              : undefined,
        ),
      });
    },
    get hasReplyOperation() {
      return Boolean(operation);
    },
    async bindQuestions(
      route: { provider: string; model: string },
      readSource: () => AdmittedRunOperatorAuthority | undefined,
    ) {
      if (directOperation && !operation && snapshot) {
        await directOperation.bindToolAuthoritySnapshotAsync(snapshot);
        snapshotTransferred = true;
        operation = directOperation;
      }
      const fingerprint = operation
        ? await operation.bindToolAuthorityRouteAsync(route)
        : await snapshot?.fingerprintAsync(route);
      // Each question retains its original operation even if a later bind transfers the snapshot.
      const boundOperation = operation;
      assertSourceCurrent?.();
      const bind = (questionSessionKey: string, assertActive: () => void) => {
        const source = readSource();
        source?.assertCurrent();
        const authority = createAgentQuestionAnswerAuthority({
          sessionKey: questionSessionKey,
          requesterProfileId: source?.profileId,
          fingerprint,
          prepareCaller: async (caller) =>
            prepareReplyToolAuthorityCallerRead(
              boundOperation?.projectToolAuthorityFingerprintAsync ?? snapshot?.projectAsync,
              caller,
              fingerprint,
              route,
              () => authority.assertActive(),
            ),
          project: (caller) =>
            boundOperation
              ? boundOperation.projectToolAuthorityFingerprint(caller)
              : snapshot?.project(caller, route),
          assertActive: () => {
            assertActive();
            source?.assertCurrent();
            assertSourceCurrent?.();
            signal?.throwIfAborted();
            if (
              boundOperation &&
              (boundOperation.result ||
                boundOperation.toolAuthorityRoute?.provider !== route.provider ||
                boundOperation.toolAuthorityRoute.model !== route.model ||
                boundOperation.toolAuthorityFingerprint !== fingerprint)
            ) {
              throw new Error("question creator reply authority is no longer active");
            }
            assertActive();
          },
        });
        return authority;
      };
      return {
        fingerprint,
        bindQuestionAnswerAuthorityForSession: bind,
        bindQuestionAnswerAuthority: (assertActive: () => void) => bind(sessionKey, assertActive),
      };
    },
  };
}

/** Capture the original caller before CLI policy replaces its canonical tool allowlist. */
function captureCliSessionEventSourcePolicy(
  params: RunCliAgentParams,
): NonNullable<PreparedCliRunContext["sessionEventSourcePolicy"]> {
  return Object.freeze({
    toolsAllow: intersectSessionEventToolsAllow(params.disableTools ? [] : params.toolsAllow),
    settings: structuredClone({
      permissionMode: params.sessionEntry?.permissionMode,
      toolOverrides: narrowSessionEventSettings(
        { toolOverrides: params.toolOverrides },
        { toolOverrides: params.sessionEntry?.toolOverrides },
      ).toolOverrides,
    }),
  });
}

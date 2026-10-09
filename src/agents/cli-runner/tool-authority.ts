import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import {
  intersectSessionEventToolsAllow,
  narrowSessionEventSettings,
} from "../../auto-reply/reply/session-event-target.js";
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

/** Bind CLI and loopback questions to the original creator, not their callback transport. */
export function bindCliQuestionAnswerAuthority(params: {
  operation: RunCliAgentParams["replyOperation"];
  snapshot: ReturnType<typeof prepareCliReplyToolAuthority> | undefined;
  route: { provider: string; model: string };
  fingerprint: string | undefined;
  readSource: () => AdmittedRunOperatorAuthority | undefined;
  assertSourceCurrent?: () => void;
  signal?: AbortSignal;
}) {
  params.assertSourceCurrent?.();
  return (sessionKey: string, assertActive: () => void) => {
    const source = params.readSource();
    source?.assertCurrent();
    const authority = createAgentQuestionAnswerAuthority({
      sessionKey,
      requesterProfileId: source?.profileId,
      fingerprint: params.fingerprint,
      prepareCaller: async (caller) =>
        prepareReplyToolAuthorityCallerRead(
          params.operation?.projectToolAuthorityFingerprintAsync ?? params.snapshot?.projectAsync,
          caller,
          params.fingerprint,
          params.route,
          () => authority.assertActive(),
        ),
      project: (caller) =>
        params.operation
          ? params.operation.projectToolAuthorityFingerprint(caller)
          : params.snapshot?.project(caller, params.route),
      assertActive: () => {
        assertActive();
        source?.assertCurrent();
        params.assertSourceCurrent?.();
        params.signal?.throwIfAborted();
        if (
          params.operation &&
          (params.operation.result ||
            params.operation.toolAuthorityRoute?.provider !== params.route.provider ||
            params.operation.toolAuthorityRoute.model !== params.route.model ||
            params.operation.toolAuthorityFingerprint !== params.fingerprint)
        ) {
          throw new Error("question creator reply authority is no longer active");
        }
        assertActive();
      },
    });
    return authority;
  };
}

/** Capture the original CLI caller before native tool availability replaces its tool cap. */
function prepareCliReplyToolAuthority(
  params: RunCliAgentParams,
  workspace: { agentId: string; workspaceDir: string; cwd: string },
) {
  return prepareReplyToolAuthority({
    originatingChannel: normalizeMessageChannel(params.messageChannel),
    toolsAllow: params.toolsAllow,
    disableTools: params.disableTools,
    operatorAuthority:
      readAdmittedRunOperatorAuthority(params.admittedRunContext) ??
      readPreparedRunOperatorAuthority(params.preparedRunAdmission),
    run: {
      ...params,
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
  });
}

/** Keep creator facts together while backend preparation translates the run's tool policy. */
export function captureCliRunToolAuthority(
  params: RunCliAgentParams,
  workspace: Parameters<typeof prepareCliReplyToolAuthority>[1],
) {
  const operation = params.toolAuthorityFingerprint ? params.replyOperation : undefined;
  const snapshot = operation ? undefined : prepareCliReplyToolAuthority(params, workspace);
  const sessionKey = params.sessionKey ?? params.sessionId;
  const signal = params.abortSignal;
  const assertSourceCurrent = params.assertCurrent;
  return {
    sessionEventSourcePolicy: captureCliSessionEventSourcePolicy(params),
    hasReplyOperation: Boolean(operation),
    async bindQuestions(
      route: { provider: string; model: string },
      readSource: () => AdmittedRunOperatorAuthority | undefined,
    ) {
      const fingerprint = operation
        ? await operation.bindToolAuthorityRouteAsync(route)
        : await snapshot?.fingerprintAsync(route);
      const bind = bindCliQuestionAnswerAuthority({
        operation,
        snapshot,
        route,
        fingerprint,
        readSource,
        assertSourceCurrent,
        signal,
      });
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

/** Native availability and prompt hooks can narrow, never replace, the caller's original cap. */
export function finalizeCliSessionEventSourcePolicy(
  original: NonNullable<PreparedCliRunContext["sessionEventSourcePolicy"]>,
  params: RunCliAgentParams,
  promptToolsAllow?: readonly string[],
): NonNullable<PreparedCliRunContext["sessionEventSourcePolicy"]> {
  return Object.freeze({
    ...original,
    toolsAllow: intersectSessionEventToolsAllow(
      original.toolsAllow,
      promptToolsAllow,
      params.disableTools
        ? []
        : params.cliToolAvailability?.native.length === 0
          ? params.cliToolAvailability.openClaw
          : undefined,
    ),
  });
}

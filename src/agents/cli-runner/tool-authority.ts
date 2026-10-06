import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import {
  readAdmittedRunOperatorAuthority,
  readPreparedRunOperatorAuthority,
  type AdmittedRunOperatorAuthority,
} from "../admitted-run-context.js";
import { createAgentQuestionAnswerAuthority } from "../harness/host-private-capabilities.js";
import type { RunCliAgentParams } from "./types.js";

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
    return createAgentQuestionAnswerAuthority({
      sessionKey,
      requesterProfileId: source?.profileId,
      fingerprint: params.fingerprint,
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
  };
}

/** Capture the original CLI caller before native tool availability replaces its tool cap. */
export function prepareCliReplyToolAuthority(
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

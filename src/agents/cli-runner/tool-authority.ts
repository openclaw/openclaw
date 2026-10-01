import { prepareReplyToolAuthority } from "../../auto-reply/reply/reply-tool-authority.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import {
  readAdmittedRunOperatorAuthority,
  readPreparedRunOperatorAuthority,
} from "../admitted-run-context.js";
import type { RunCliAgentParams } from "./types.js";

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

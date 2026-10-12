import type { OpenClawConfig } from "../runtime-api.js";
import { findMSTeamsConversationMember } from "./graph-conversation-members.js";
import { resolveConversationPath, resolveGraphConversationId } from "./graph-messages.js";
import { deleteGraphRequest, escapeOData, mutateGraphJson, resolveGraphToken } from "./graph.js";

type AddParticipantMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  userId: string;
  role?: string;
};

type ConversationMemberRole = "member" | "owner";

function resolveConversationMemberRoles(
  role: string | undefined,
  kind: "chat" | "channel",
): ConversationMemberRole[] {
  const normalized = role?.trim().toLowerCase() || "member";
  if (normalized !== "member" && normalized !== "owner") {
    throw new Error('MS Teams participant role must be "member" or "owner".');
  }
  if (kind === "chat") {
    // Graph accepts chat additions only as owners; "member" is the public
    // convenience role and maps to the provider's required representation.
    return ["owner"];
  }
  return normalized === "owner" ? ["owner"] : [];
}

export async function addParticipantMSTeams(params: AddParticipantMSTeamsParams) {
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const conv = resolveConversationPath(conversationId);

  const body = {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: resolveConversationMemberRoles(params.role, conv.kind),
    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${escapeOData(params.userId)}')`,
  };

  await mutateGraphJson<unknown>({
    token,
    path: `${conv.basePath}/members`,
    method: "POST",
    body,
  });

  return { added: { userId: params.userId, chatId: conversationId } };
}

type RemoveParticipantMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  userId: string;
};

/**
 * Remove a user from a chat or channel via Graph API.
 * Lists members first to resolve the membership ID, then deletes.
 */
export async function removeParticipantMSTeams(params: RemoveParticipantMSTeamsParams) {
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const { conversationId, member } = await findMSTeamsConversationMember({
    token,
    to: params.to,
    cfg: params.cfg,
    accountId: params.accountId,
    userId: params.userId,
  });
  if (!member?.id) {
    throw new Error(`User ${params.userId} is not a member of this conversation`);
  }
  const conv = resolveConversationPath(conversationId);

  await deleteGraphRequest({
    token,
    path: `${conv.basePath}/members/${encodeURIComponent(member.id)}`,
  });

  return { removed: { userId: params.userId, chatId: conversationId } };
}

type RenameGroupMSTeamsParams = {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  name: string;
};

export async function renameGroupMSTeams(params: RenameGroupMSTeamsParams) {
  const token = await resolveGraphToken(params.cfg, { accountId: params.accountId });
  const conversationId = await resolveGraphConversationId(params.to, {
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const conv = resolveConversationPath(conversationId);

  const body = conv.kind === "chat" ? { topic: params.name } : { displayName: params.name };

  await mutateGraphJson<unknown>({
    token,
    path: conv.basePath,
    method: "PATCH",
    body,
  });

  return { renamed: { chatId: conversationId, newName: params.name } };
}

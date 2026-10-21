import type { OpenClawConfig } from "../runtime-api.js";
import { resolveGraphMessageContext } from "./graph-messages.js";
import { deleteGraphRequest, escapeOData, fetchAllGraphPages, mutateGraphJson } from "./graph.js";

type MSTeamsConversationMember = {
  id?: string;
  userId?: string;
  email?: string;
};

const MAX_CONVERSATION_MEMBER_PAGES = 100;

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
  const { token, conversationId, kind, basePath } = await resolveGraphMessageContext(params);

  const body = {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: resolveConversationMemberRoles(params.role, kind),
    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${escapeOData(params.userId)}')`,
  };

  await mutateGraphJson<unknown>({
    token,
    path: `${basePath}/members`,
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
  const { token, conversationId, basePath } = await resolveGraphMessageContext(params);
  const userId = params.userId.trim().toLowerCase();
  const result = await fetchAllGraphPages<MSTeamsConversationMember>({
    token,
    path: `${basePath}/members`,
    maxPages: MAX_CONVERSATION_MEMBER_PAGES,
    collectItems: false,
    findOne: (candidate) =>
      candidate.userId?.trim().toLowerCase() === userId ||
      candidate.email?.trim().toLowerCase() === userId,
  });
  if (result.truncated) {
    throw new Error("MS Teams conversation member pagination limit exceeded");
  }
  const member = result.found;
  if (!member?.id) {
    throw new Error(`User ${params.userId} is not a member of this conversation`);
  }
  await deleteGraphRequest({
    token,
    path: `${basePath}/members/${encodeURIComponent(member.id)}`,
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
  const { token, conversationId, kind, basePath } = await resolveGraphMessageContext(params);

  const body = kind === "chat" ? { topic: params.name } : { displayName: params.name };

  await mutateGraphJson<unknown>({
    token,
    path: basePath,
    method: "PATCH",
    body,
  });

  return { renamed: { chatId: conversationId, newName: params.name } };
}

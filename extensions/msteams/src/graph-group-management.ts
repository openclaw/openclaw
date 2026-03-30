import type { OpenClawConfig } from "../runtime-api.js";
import { resolveConversationPath, resolveGraphConversationId } from "./graph-messages.js";
import {
  deleteGraphRequest,
  fetchGraphJson,
  patchGraphJson,
  postGraphJson,
  resolveGraphToken,
} from "./graph.js";

// ---------------------------------------------------------------------------
// Add Participant
// ---------------------------------------------------------------------------

export type AddParticipantMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  userId: string;
  role?: string;
};

export type AddParticipantMSTeamsResult = {
  added: { userId: string; chatId: string };
};

/**
 * Add a user to a chat or channel via Graph API.
 */
export async function addParticipantMSTeams(
  params: AddParticipantMSTeamsParams,
): Promise<AddParticipantMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);

  const body = {
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles: [params.role || "member"],
    "user@odata.bind": `https://graph.microsoft.com/v1.0/users('${params.userId}')`,
  };

  await postGraphJson<unknown>({
    token,
    path: `${conv.basePath}/members`,
    body,
  });

  return { added: { userId: params.userId, chatId: conversationId } };
}

// ---------------------------------------------------------------------------
// Remove Participant
// ---------------------------------------------------------------------------

export type RemoveParticipantMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  userId: string;
};

export type RemoveParticipantMSTeamsResult = {
  removed: { userId: string; chatId: string };
};

type GraphConversationMember = {
  id?: string;
  userId?: string;
};

/**
 * Remove a user from a chat or channel via Graph API.
 * Lists members first to resolve the membership ID, then deletes.
 */
export async function removeParticipantMSTeams(
  params: RemoveParticipantMSTeamsParams,
): Promise<RemoveParticipantMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);

  // List members to find the membership ID for the target user
  const membersRes = await fetchGraphJson<{ value?: GraphConversationMember[] }>({
    token,
    path: `${conv.basePath}/members`,
  });

  const member = (membersRes.value ?? []).find((m) => m.userId === params.userId);
  if (!member?.id) {
    throw new Error(`User ${params.userId} is not a member of this conversation`);
  }

  await deleteGraphRequest({
    token,
    path: `${conv.basePath}/members/${encodeURIComponent(member.id)}`,
  });

  return { removed: { userId: params.userId, chatId: conversationId } };
}

// ---------------------------------------------------------------------------
// Rename Group
// ---------------------------------------------------------------------------

export type RenameGroupMSTeamsParams = {
  cfg: OpenClawConfig;
  to: string;
  name: string;
};

export type RenameGroupMSTeamsResult = {
  renamed: { chatId: string; newName: string };
};

/**
 * Rename a chat (topic) or channel (displayName) via Graph API.
 */
export async function renameGroupMSTeams(
  params: RenameGroupMSTeamsParams,
): Promise<RenameGroupMSTeamsResult> {
  const token = await resolveGraphToken(params.cfg);
  const conversationId = await resolveGraphConversationId(params.to);
  const conv = resolveConversationPath(conversationId);

  const body = conv.kind === "chat" ? { topic: params.name } : { displayName: params.name };

  await patchGraphJson<unknown>({
    token,
    path: conv.basePath,
    body,
  });

  return { renamed: { chatId: conversationId, newName: params.name } };
}

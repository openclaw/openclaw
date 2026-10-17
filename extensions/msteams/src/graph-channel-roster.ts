import { fetchAllGraphPages } from "./graph.js";

// Graph conversation members describe users, not bot/app installations.
export type MSTeamsChannelRosterMember = {
  id?: string;
  userId: string;
  displayName?: string;
  email?: string;
  roles?: string[];
  "@odata.type"?: string;
};

export async function listMSTeamsChannelRoster(params: {
  token: string;
  teamId: string;
  channelId: string;
  membershipType: string | undefined;
}) {
  // Shared channels also have indirect members that /members cannot enumerate.
  if (params.membershipType !== "private") {
    throw new Error(
      `Microsoft Teams channel roster is not supported for membershipType=${params.membershipType ?? "unknown"}`,
    );
  }
  const path = `/teams/${encodeURIComponent(params.teamId)}/channels/${encodeURIComponent(params.channelId)}/members`;
  const result = await fetchAllGraphPages<MSTeamsChannelRosterMember>({
    token: params.token,
    path,
    maxPages: 100,
    strict: true,
  });
  if (result.truncated) {
    throw new Error("Microsoft Teams channel roster pagination limit exceeded");
  }
  if (
    result.items.some(
      (member) =>
        !member ||
        typeof member.userId !== "string" ||
        !member.userId.trim() ||
        (member["@odata.type"] !== undefined &&
          member["@odata.type"] !== "#microsoft.graph.aadUserConversationMember"),
    )
  ) {
    throw new Error(
      "Microsoft Teams channel roster contains an unsupported or invalid user member",
    );
  }
  return result.items;
}

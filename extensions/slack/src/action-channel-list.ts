import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { SlackActionContext } from "./action-context.js";
import {
  readSlackConversationListParams,
  resolveSlackTokenPolicyTeamId,
} from "./action-read-params.js";
import {
  hasSlackRequesterAccount,
  isSlackResolvedReadTargetAllowed,
} from "./action-read-policy.js";
import type {
  SlackConversationListOptions,
  SlackConversationSummary,
  SlackTokenWorkspace,
} from "./conversation-list.js";
import { formatSlackTarget } from "./target-parsing.js";
import { slackContextTargetsMatch } from "./targets.js";

/** One channel-list page, limited to conversations `read` would allow for this caller. */
export async function listSlackReadableConversations(params: {
  account: ResolvedSlackAccount;
  cfg: OpenClawConfig;
  params: Record<string, unknown>;
  context?: SlackActionContext;
  readToken?: string;
  requestedTeamId?: string;
  listConversations: (
    options: SlackConversationListOptions,
  ) => Promise<{ conversations: SlackConversationSummary[]; nextCursor?: string }>;
  lookupWorkspace: () => Promise<SlackTokenWorkspace>;
}) {
  const { account, context } = params;
  // A bot sees every public channel; list only conversations its token can read.
  const membersOnly = !params.readToken || params.readToken !== account.userToken?.trim();
  // Workspace-qualified policy needs the listing workspace before any filtering.
  const teamId = await resolveSlackTokenPolicyTeamId({
    account,
    selectedToken: params.readToken,
    requestedTeamId: params.requestedTeamId,
    lookup: params.lookupWorkspace,
  });
  const page = await params.listConversations(readSlackConversationListParams(params.params));
  const requesterAccount = hasSlackRequesterAccount(account, context);
  const channels: SlackConversationSummary[] = [];
  for (const conversation of page.conversations) {
    if (membersOnly && !conversation.isMember) {
      continue;
    }
    // Identity keeps the caller's qualification so an unqualified current context matches;
    // policy uses the resolved listing workspace.
    const target = formatSlackTarget({
      teamId: params.requestedTeamId,
      kind: "channel",
      id: conversation.id,
    });
    const allowed = await isSlackResolvedReadTargetAllowed({
      account,
      cfg: params.cfg,
      channelId: conversation.id,
      teamId,
      conversationReadOrigin: context?.conversationReadOrigin,
      info: {
        type:
          conversation.type === "im" ? "dm" : conversation.type === "mpim" ? "group" : "channel",
        name: conversation.name,
        user: conversation.userId,
      },
      currentConversation: Boolean(
        requesterAccount && context && slackContextTargetsMatch(target, context),
      ),
    });
    if (allowed) {
      channels.push(conversation);
    }
  }
  return {
    ok: true,
    ...(teamId ? { teamId } : {}),
    channels,
    ...(page.nextCursor ? { nextPageToken: page.nextCursor } : {}),
  };
}

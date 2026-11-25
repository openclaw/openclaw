import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { ResolvedSlackAccount } from "./accounts.js";
import { hasSlackTeamScopedPolicy } from "./action-read-policy.js";
import type { SlackConversationListOptions, SlackTokenWorkspace } from "./conversation-list.js";
import { SLACK_CONVERSATION_LIST_TYPES } from "./cursor-pages.js";
import { getSlackInstallationTeamId } from "./installation-identity-state.js";

const SLACK_CONVERSATION_LIST_DEFAULT_LIMIT = 200;
const SLACK_CONVERSATION_LIST_MAX_LIMIT = 1000;

/** readAs makes the owner's token choice explicit; omitted keeps the account default. */
export function resolveSlackReadAsToken(
  account: ResolvedSlackAccount,
  params: Record<string, unknown>,
): string | undefined {
  const readAs = readStringParam(params, "readAs");
  if (readAs === undefined) {
    return undefined;
  }
  if (readAs !== "bot" && readAs !== "user") {
    throw new Error('Slack readAs must be "bot" or "user".');
  }
  const token = readAs === "bot" ? account.botToken?.trim() : account.userToken?.trim();
  if (!token) {
    throw new Error(
      `Slack readAs "${readAs}" requires a configured ${readAs} token for account "${account.accountId}".`,
    );
  }
  return token;
}

/**
 * Workspace whose policy applies to conversations read with the selected token: the
 * requested one, the monitor's when it authenticated this same credential, else auth.test.
 */
export async function resolveSlackTokenPolicyTeamId(params: {
  account: ResolvedSlackAccount;
  selectedToken?: string;
  requestedTeamId?: string;
  lookup: () => Promise<SlackTokenWorkspace>;
}): Promise<string | undefined> {
  const { account, requestedTeamId } = params;
  // The monitor authenticates the user token for user identity and the bot token otherwise.
  const monitorToken = account.identity === "user" ? account.userToken : account.botToken;
  const installTeamId =
    params.selectedToken && params.selectedToken === monitorToken?.trim()
      ? getSlackInstallationTeamId(account.accountId)
      : undefined;
  const workspace = installTeamId
    ? { teamId: installTeamId, enterpriseInstall: false }
    : await params.lookup();
  if (
    requestedTeamId &&
    workspace.teamId &&
    !workspace.enterpriseInstall &&
    workspace.teamId.toLowerCase() !== requestedTeamId.toLowerCase()
  ) {
    throw new Error(
      `Slack teamId ${requestedTeamId} does not match workspace ${workspace.teamId} of the selected token.`,
    );
  }
  return requestedTeamId ?? workspace.teamId;
}

/** Policy workspace for a read target the caller left unqualified. */
export async function resolveSlackReadPolicyTeamId(params: {
  account: ResolvedSlackAccount;
  targetTeamId?: string;
  selectedToken?: string;
  lookup: () => Promise<SlackTokenWorkspace>;
}): Promise<string | undefined> {
  return (
    params.targetTeamId ??
    (hasSlackTeamScopedPolicy(params.account)
      ? await resolveSlackTokenPolicyTeamId(params)
      : undefined)
  );
}

export function readSlackConversationListParams(
  params: Record<string, unknown>,
): SlackConversationListOptions {
  return {
    types: readSlackConversationListTypes(params.types),
    includeArchived: readBooleanParam(params, "includeArchived") === true,
    limit: Math.min(
      readPositiveIntegerParam(params, "limit", {
        message: "limit must be a positive integer.",
      }) ?? SLACK_CONVERSATION_LIST_DEFAULT_LIMIT,
      SLACK_CONVERSATION_LIST_MAX_LIMIT,
    ),
    cursor: readStringParam(params, "pageToken"),
  };
}

function readSlackConversationListTypes(value: unknown) {
  if (value === undefined) {
    return SLACK_CONVERSATION_LIST_TYPES.filter((type) => type.endsWith("_channel"));
  }
  const requested: unknown = typeof value === "string" ? value.split(",") : value;
  const known = new Set<unknown>(SLACK_CONVERSATION_LIST_TYPES);
  if (
    !Array.isArray(requested) ||
    requested.length === 0 ||
    requested.some((entry) => !known.has(typeof entry === "string" ? entry.trim() : entry))
  ) {
    throw new Error(
      `Slack channel-list types must be one or more of: ${SLACK_CONVERSATION_LIST_TYPES.join(", ")}.`,
    );
  }
  return SLACK_CONVERSATION_LIST_TYPES.filter((type) =>
    requested.some((entry) => typeof entry === "string" && entry.trim() === type),
  );
}

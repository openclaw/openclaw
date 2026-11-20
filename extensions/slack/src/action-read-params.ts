import { readBooleanParam } from "openclaw/plugin-sdk/boolean-param";
import { readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { SlackConversationListOptions } from "./conversation-list.js";
import { SLACK_CONVERSATION_LIST_TYPES } from "./cursor-pages.js";

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

export function readSlackConversationListParams(
  params: Record<string, unknown>,
): Omit<SlackConversationListOptions, "knownTeamId"> {
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

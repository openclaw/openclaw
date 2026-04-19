/**
 * Member-related tools.
 *
 * Contains:
 * - query_session_members: Query session members (find by nickname, @mention, list all, etc.)
 *
 * Query strategy: prefer GroupMember (WS API layer) -> fallback to SessionMember (session cache layer).
 * For group owner info, use the query_group_info tool.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getMember } from "../../infra/cache/member.js";
import { extractGroupCode, type OpenClawPluginToolContext, json } from "../utils/utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @mention hint text (used as JSON field value) */
const MENTION_HINT_TEXT =
  'To @mention a user, you MUST use the format: space + @ + nickname + space (e.g. " @Alice ").';

/** User role type mapping (0=undefined, 1=user, 2=yuanbao, 3=bot) */
const USER_TYPE_LABEL: Record<number, string> = {
  0: "undefined",
  1: "user",
  2: "yuanbao",
  3: "bot",
};

// ---------------------------------------------------------------------------
// Member record types & mapping utilities
// ---------------------------------------------------------------------------

/** Single member record returned by queryMembers */
type MemberRecord = { nickName: string; userId: string; userType?: number };

/** Map user records to a compact format */
function toMembers(records: MemberRecord[]) {
  return records.map((u) => ({
    nickname: u.nickName,
    userId: u.userId,
    ...(u.userType !== undefined
      ? { role: USER_TYPE_LABEL[u.userType] ?? `type_${u.userType}` }
      : {}),
  }));
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

/** List bots in the group (including Yuanbao AI assistants and other bots) */
function handleListBots(allMembers: MemberRecord[], mention: boolean) {
  const bots = allMembers.filter((u) => u.userType === 2 || u.userType === 3);
  if (bots.length === 0) {
    return json({ success: false, msg: "No bot info available. Role data requires API fetch." });
  }
  return json({
    success: true,
    msg: `Found ${bots.length} bot(s) in this group.`,
    members: toMembers(bots),
    ...(mention ? { mentionHint: MENTION_HINT_TEXT } : {}),
  });
}

/**
 * Fuzzy search group members by nickname.
 *
 * Lookup strategy:
 * 1. nameFilter provided + match found -> return matched results
 * 2. nameFilter provided + no match -> return all members for model analysis
 * 3. No nameFilter -> fallback to list_all behavior
 */
function handleFind(allMembers: MemberRecord[], nameFilter: string, mention: boolean) {
  const hint = mention ? { mentionHint: MENTION_HINT_TEXT } : {};

  if (nameFilter) {
    const filter = nameFilter.toLowerCase();
    const matched = allMembers.filter((u) => u.nickName.toLowerCase().includes(filter));

    if (matched.length > 0) {
      return json({
        success: true,
        msg: `Found ${matched.length} member(s) matching "${nameFilter}".`,
        members: toMembers(matched),
        ...hint,
      });
    }

    // No exact match by nickname, return all members for model analysis
    return json({
      success: false,
      msg: `No exact match for "${nameFilter}". Please find the target user from the members list below.`,
      members: toMembers(allMembers),
      ...hint,
    });
  }

    // No nameFilter for find, fallback to listing all members
  return json({
    success: true,
    msg: `Found ${allMembers.length} member(s) in this group.`,
    members: toMembers(allMembers),
    ...hint,
  });
}

/** List all members */
function handleListAll(allMembers: MemberRecord[], mention: boolean) {
  return json({
    success: true,
    msg: `Found ${allMembers.length} member(s) in this group.`,
    members: toMembers(allMembers),
    ...(mention ? { mentionHint: MENTION_HINT_TEXT } : {}),
  });
}

// ---------------------------------------------------------------------------
// query_session_members
// ---------------------------------------------------------------------------

/**
 * Create the query_session_members tool definition.
 *
 * Merges the original lookup_session_members and query_group_members into one tool.
 * Prefers API-fetched full member list; session cache as fallback.
 */function createQuerySessionMembersTool(ctx: OpenClawPluginToolContext) {
  const sessionKey: string = ctx.sessionKey ?? "";
  const accountId: string = ctx.agentAccountId ?? "";

  return {
    name: "query_session_members",
    label: "Query Session Members",
    description:
      'Query session members in the current group (called "派/Pai" in the app): ' +
      "find a user by name, @mention someone, list bots (including Yuanbao AI assistants), or list all members.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["find", "list_bots", "list_all"],
          description:
            "Interaction type. " +
            "find — search a user by name; " +
            "list_bots — list bots (including Yuanbao AI assistants) in the group; " +
            "list_all — list all recorded members.",
        },
        name: {
          type: "string",
          description:
            "User name to search (partial match, case-insensitive). " +
            'Required for "find", ignored for other actions.',
        },
        mention: {
          type: "boolean",
          description: "Set to true when you need to @mention the user(s) in the reply. ",
        },
      },
      required: ["action", "mention"],
    },
    /**
     * Execute session member query.
     *
     * 1. No groupCode -> inform model no group context
     * 2. Query via Member facade: prefer GroupMember (WS API) -> fallback SessionMember (cache)
     * 3. Dispatch to action handlers
     */
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action : "list_all";
      const nameFilter = typeof params.name === "string" ? params.name.trim() : "";
      const mention = params.mention === true || params.mention === "true";

      // Extract groupCode from sessionKey
      const groupCode = extractGroupCode(sessionKey);

      if (!groupCode) {
        return json({
          success: false,
          msg: "No group context available, unable to query members.",
        });
      }

      const allMembers = await getMember(accountId).queryMembers(groupCode);

      if (allMembers.length === 0) {
        return json({ success: false, msg: "No members recorded in this group yet." });
      }

      switch (action) {
        case "list_bots":
          return handleListBots(allMembers, mention);
        case "find":
          return handleFind(allMembers, nameFilter, mention);
        case "list_all":
          return handleListAll(allMembers, mention);
        default:
          return json({
            success: false,
            msg: `Unsupported action "${action}". Valid actions: find, list_bots, list_all.`,
          });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Registration entry
// ---------------------------------------------------------------------------

/**
 * Register all tools under the "member" category.
 *
 * Currently contains:
 * - query_session_members: Query session members (always available)
 */
export function registerMemberTools(api: OpenClawPluginApi): void {
  api.registerTool(createQuerySessionMembersTool, { optional: false });
}

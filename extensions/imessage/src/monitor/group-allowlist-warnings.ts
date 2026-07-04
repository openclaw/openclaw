// Group-allowlist visibility helpers. With groupPolicy="allowlist" the inbound
// gates drop every group message only when channels.imessage.groups is empty
// AND no effective group sender allowlist exists (groupAllowFrom, or its
// allowFrom fallback). A non-empty groupAllowFrom admits groups despite an
// empty groups map (senderFilterBypass in src/config/group-policy.ts). Without
// these warnings the drop-all case is invisible at default log level during
// iMessage config migration. See
// https://github.com/openclaw/openclaw/issues/78749.

type GroupsConfig = Record<
  string,
  { requireMention?: boolean; tools?: unknown; toolsBySender?: unknown }
>;

const startupWarned = new Set<string>();
const perChatWarned = new Set<string>();

/**
 * Fires once per `accountId` at monitor startup when `groupPolicy === "allowlist"`
 * and group messages cannot be admitted at all: `channels.imessage.groups` is
 * empty (no `"*"` wildcard, no explicit `chat_id` entries) AND the effective
 * group sender allowlist is empty. With a non-empty `groupAllowFrom`,
 * sender-level filtering admits groups despite the empty groups map, so that
 * configuration is valid and no warning fires.
 */
export function warnGroupAllowlistMisconfigOnce(params: {
  groupPolicy: string;
  groups: GroupsConfig | undefined;
  hasGroupAllowFrom: boolean;
  accountId: string;
  log: (message: string) => void;
}): boolean {
  if (params.groupPolicy !== "allowlist") {
    return false;
  }
  const entries = params.groups ? Object.keys(params.groups) : [];
  if (entries.length > 0) {
    return false;
  }
  // A non-empty effective groupAllowFrom admits groups without a groups map
  // (senderFilterBypass in src/config/group-policy.ts) — not a misconfig.
  if (params.hasGroupAllowFrom) {
    return false;
  }
  const key = `imessage:${params.accountId}`;
  if (startupWarned.has(key)) {
    return false;
  }
  startupWarned.add(key);
  params.log(
    `imessage: groupPolicy="allowlist" for account "${params.accountId}" but channels.imessage.groups is empty ` +
      `and no group sender allowlist is configured (channels.imessage.groupAllowFrom, or its allowFrom fallback). ` +
      `Every inbound group message will be dropped. ` +
      `Set channels.imessage.groupAllowFrom (sender handles, chat targets like chat_id:<id>, or "*") to admit group senders, ` +
      `and optionally add channels.imessage.groups entries to scope which chats are allowed.`,
  );
  return true;
}

/**
 * Fires once per `accountId:chat_id` when the runtime allowlist gate drops a
 * group message because that chat_id is not in `channels.imessage.groups`.
 * Bounded by the number of distinct group chats the gateway sees.
 */
export function warnGroupAllowlistDropPerChatOnce(params: {
  accountId: string;
  chatId: string | number | undefined;
  log: (message: string) => void;
}): boolean {
  const chat = params.chatId == null ? "" : String(params.chatId).trim();
  if (!chat) {
    return false;
  }
  const key = `imessage:${params.accountId}:${chat}`;
  if (perChatWarned.has(key)) {
    return false;
  }
  perChatWarned.add(key);
  params.log(
    `imessage: dropping group message from chat_id=${chat} (account "${params.accountId}") — ` +
      `not in channels.imessage.groups allowlist. ` +
      `Add channels.imessage.groups["${chat}"] or channels.imessage.groups["*"] to allow it.`,
  );
  return true;
}

/** Test helper. Keeps warning-cache state deterministic across test files. */
export function resetGroupAllowlistWarningsForTesting(): void {
  startupWarned.clear();
  perChatWarned.clear();
}

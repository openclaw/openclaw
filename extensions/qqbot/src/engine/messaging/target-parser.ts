/**
 * QQ Bot target address parser — parse "qqbot:c2c:xxx" style addresses
 * into structured delivery targets.
 *
 * All functions are **pure** (no side effects, no I/O), making them easy
 * to test and safe to share between the built-in and standalone versions.
 */

/** Supported target types. */
type TargetType = "c2c" | "group" | "channel";

/** Parsed delivery target. */
interface ParsedTarget {
  type: TargetType;
  id: string;
}

function stripProviderPrefix(raw: string): string {
  const trimmed = raw.trim();
  const id = trimmed.replace(/^qqbot:/i, "");
  if (/^qqbot:/i.test(id)) {
    throw new Error(`Invalid target format: ${raw} - repeated qqbot: prefix`);
  }
  return id;
}

function stripProviderPrefixOrUndefined(raw: string): string | undefined {
  try {
    return stripProviderPrefix(raw);
  } catch {
    return undefined;
  }
}

function readTypedId(id: string, type: TargetType): string | undefined {
  const prefix = `${type}:`;
  return id.toLowerCase().startsWith(prefix) ? id.slice(prefix.length) : undefined;
}

function startsWithForeignProviderPrefix(raw: string): boolean {
  const prefix = /^([a-z][a-z0-9_-]*):/i.exec(raw.trim())?.[1]?.toLowerCase();
  return (
    prefix != null &&
    prefix !== "qqbot" &&
    prefix !== "c2c" &&
    prefix !== "group" &&
    prefix !== "channel"
  );
}

/**
 * Parse a qqbot target string into a structured delivery target.
 *
 * Supported formats:
 * - `qqbot:c2c:openid` → C2C direct message
 * - `qqbot:group:groupid` → Group message
 * - `qqbot:channel:channelid` → Channel message
 * - `c2c:openid` → C2C (without qqbot: prefix)
 * - `group:groupid` → Group (without qqbot: prefix)
 * - `channel:channelid` → Channel (without qqbot: prefix)
 * - `openid` → C2C (bare openid, default)
 *
 * @param to - Raw target string.
 * @returns Parsed target with type and id.
 * @throws {Error} When the target format is invalid.
 */
export function parseTarget(to: string): ParsedTarget {
  const id = stripProviderPrefix(to);

  const c2cId = readTypedId(id, "c2c");
  if (c2cId != null) {
    const userId = c2cId;
    if (!userId) {
      throw new Error(`Invalid c2c target format: ${to} - missing user ID`);
    }
    return { type: "c2c", id: userId };
  }

  const groupId = readTypedId(id, "group");
  if (groupId != null) {
    if (!groupId) {
      throw new Error(`Invalid group target format: ${to} - missing group ID`);
    }
    return { type: "group", id: groupId };
  }

  const channelId = readTypedId(id, "channel");
  if (channelId != null) {
    if (!channelId) {
      throw new Error(`Invalid channel target format: ${to} - missing channel ID`);
    }
    return { type: "channel", id: channelId };
  }

  if (!id) {
    throw new Error(`Invalid target format: ${to} - empty ID after removing qqbot: prefix`);
  }

  // Default to C2C when no type prefix is present.
  return { type: "c2c", id };
}

/**
 * Normalize a QQ Bot target string into the canonical `qqbot:...` form.
 *
 * Returns `undefined` when the target does not look like a QQ Bot address.
 */
export function normalizeTarget(target: string): string | undefined {
  const id = stripProviderPrefixOrUndefined(target);
  if (!id) {
    return undefined;
  }
  for (const type of ["c2c", "group", "channel"] as const) {
    const typedId = readTypedId(id, type);
    if (typedId != null) {
      return typedId ? `qqbot:${type}:${typedId}` : undefined;
    }
  }
  // 32-char hex openid
  if (/^[0-9a-fA-F]{32}$/.test(id)) {
    return `qqbot:c2c:${id}`;
  }
  // UUID-format openid
  if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id)) {
    return `qqbot:c2c:${id}`;
  }
  return undefined;
}

/**
 * Parse a QQ Bot explicit route target for shared delivery/session routing.
 *
 * The returned `to` is channel-local because callers already know the channel.
 */
export function parseExplicitTarget(
  raw: string,
): { to: string; chatType: "direct" | "group" | "channel" } | null {
  if (startsWithForeignProviderPrefix(raw)) {
    return null;
  }
  try {
    const target = parseTarget(raw);
    return {
      to: `${target.type}:${target.id}`,
      chatType: target.type === "c2c" ? "direct" : target.type === "group" ? "group" : "channel",
    };
  } catch {
    return null;
  }
}

/**
 * Return true when the string looks like a QQ Bot target ID.
 */
export function looksLikeQQBotTarget(id: string): boolean {
  if (/^qqbot:(c2c|group|channel):/i.test(id)) {
    return true;
  }
  if (/^(c2c|group|channel):/i.test(id)) {
    return true;
  }
  if (/^[0-9a-fA-F]{32}$/.test(id)) {
    return true;
  }
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(id);
}

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

function stripQQBotProviderPrefix(to: string): string {
  const trimmed = to.trim();
  const id = trimmed.replace(/^qqbot:/i, "");
  if (/^qqbot:/i.test(id)) {
    throw new Error(`Invalid target format: ${to} - repeated qqbot: provider prefix`);
  }
  return id;
}

function parseTypedTarget(id: string): { type: TargetType; value: string } | undefined {
  const match = /^(c2c|group|channel):(.*)$/i.exec(id);
  if (!match) {
    return undefined;
  }
  return {
    type: match[1].toLowerCase() as TargetType,
    value: match[2],
  };
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
  const id = stripQQBotProviderPrefix(to);

  const typed = parseTypedTarget(id);
  if (typed) {
    if (!typed.value) {
      throw new Error(`Invalid ${typed.type} target format: ${to} - missing target ID`);
    }
    return { type: typed.type, id: typed.value };
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
  try {
    const parsed = parseTarget(target);
    if (
      parsed.type !== "c2c" ||
      /^[0-9a-fA-F]{32}$/.test(parsed.id) ||
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
        parsed.id,
      ) ||
      /^(c2c|group|channel):/i.test(stripQQBotProviderPrefix(target))
    ) {
      return `qqbot:${parsed.type}:${parsed.id}`;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * Return true when the string looks like a QQ Bot target ID.
 */
export function looksLikeQQBotTarget(id: string): boolean {
  if (/^qqbot:qqbot:/i.test(id.trim())) {
    return false;
  }
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

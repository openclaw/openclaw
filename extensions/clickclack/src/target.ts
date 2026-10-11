import type { ClickClackTarget } from "./types.js";

/**
 * Parses `channel:name`, `thread:msg_id`, `dm:usr_id`, or a bare channel name.
 */
export function parseClickClackTarget(raw: string): ClickClackTarget {
  const value = raw.trim();
  if (!value) {
    throw new Error("ClickClack target is required");
  }
  const [prefix, ...rest] = value.split(":");
  const body = rest.join(":").trim();
  if (prefix === "channel" && body) {
    return { chatType: "group", kind: "channel", id: body };
  }
  if (prefix === "thread" && body) {
    return { chatType: "group", kind: "thread", id: body };
  }
  if (prefix === "dm" && body) {
    return { chatType: "direct", kind: "dm", id: body };
  }
  if (!body) {
    return { chatType: "group", kind: "channel", id: value };
  }
  throw new Error(`Unsupported ClickClack target: ${raw}`);
}

export function buildClickClackTarget(target: ClickClackTarget): string {
  return `${target.kind}:${target.id}`;
}

export function normalizeClickClackTarget(raw: string): string {
  return buildClickClackTarget(parseClickClackTarget(raw));
}

export function looksLikeClickClackTarget(raw: string): boolean {
  return raw.trim().length > 0;
}

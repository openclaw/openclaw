// Plain-language text for the People page: who someone is, what their devices
// are doing and what a removal cut. Pure functions, so the wording is tested
// without rendering.
import type { Invite, Member, MemberDevice, RemovalSummary } from "./types.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Short day ("Nov 5") for seconds since the epoch. */
export function formatDay(seconds: number, locale: string): string {
  return new Date(seconds * 1000).toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** The name to show for a member: reported name, then email, then account id. */
export function memberName(member: Member): string {
  return member.displayName || member.email || member.accountId;
}

/** "1 device" / "2 devices". */
export function countDevices(count: number): string {
  return `${count} ${count === 1 ? "device" : "devices"}`;
}

/** "just now", "5 min ago", "3 h ago" or "2 days ago" for a past time in ms. */
export function formatAgo(atMs: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - atMs);
  if (elapsed < MINUTE_MS) {
    return "just now";
  }
  if (elapsed < HOUR_MS) {
    return `${Math.floor(elapsed / MINUTE_MS)} min ago`;
  }
  if (elapsed < DAY_MS) {
    return `${Math.floor(elapsed / HOUR_MS)} h ago`;
  }
  const days = Math.floor(elapsed / DAY_MS);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

/**
 * A member's presence across their devices: "active now" while any device is
 * connected, else "last seen …", else "not seen yet" (since the Gateway started).
 */
export function memberPresence(devices: readonly MemberDevice[], nowMs: number): string {
  if (devices.some((device) => device.connections > 0)) {
    return "active now";
  }
  const seen = devices
    .map((device) => device.lastSeenAt)
    .filter((value): value is number => typeof value === "number");
  return seen.length > 0 ? `last seen ${formatAgo(Math.max(...seen), nowMs)}` : "not seen yet";
}

/**
 * What a member is running right now, by session title when the host knows it:
 * 'running "Summarize Q3 notes"', 'running 2 tasks', or undefined when idle.
 */
export function memberRunning(
  devices: readonly MemberDevice[],
  sessionTitle: (sessionKey: string) => string | undefined,
): string | undefined {
  const runs = devices.flatMap((device) => device.runs);
  if (runs.length === 0) {
    return undefined;
  }
  const title = runs.length === 1 ? sessionTitle(runs[0]!.sessionKey) : undefined;
  return title
    ? `running “${title}”`
    : `running ${runs.length} ${runs.length === 1 ? "task" : "tasks"}`;
}

/** The invite's role and creation day, without repeating the requester's email. */
export function inviteUsed(invite: Invite, locale: string): string {
  const role = invite.role.charAt(0).toUpperCase() + invite.role.slice(1);
  return `${role} invite · created ${formatDay(invite.createdAt, locale)}`;
}

/** What a removal changed, e.g. "Bob removed · 1 connection closed · 1 task stopped". */
export function removalNote(name: string, removal: RemovalSummary | null): string {
  if (!removal) {
    return `${name} removed`;
  }
  const parts = [`${name} removed`];
  parts.push(
    `${removal.connectionsClosed} ${removal.connectionsClosed === 1 ? "connection" : "connections"} closed`,
  );
  parts.push(`${removal.runsCancelled} ${removal.runsCancelled === 1 ? "task" : "tasks"} stopped`);
  return parts.join(" · ");
}

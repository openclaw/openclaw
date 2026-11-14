// Plain-language text for the People page: who someone is, what their devices
// are doing and what a removal cut. Pure functions, so the wording is tested
// without rendering.
import type { Member, MemberDevice, OwnerDevice, RemovalSummary } from "./types.js";

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
 * connected, else the most recent live or persisted "last seen …", else "not seen yet".
 */
export function memberPresence(devices: readonly MemberDevice[], nowMs: number): string {
  if (devices.some((device) => device.connections > 0)) {
    return "active now";
  }
  const seen = devices
    .flatMap((device) => [
      device.lastSeenAt,
      device.lastSeen === null ? null : device.lastSeen * 1000,
    ])
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

/** Device approval provenance, resolving fingerprints to labels when listed. */
export function deviceApprover(
  device: MemberDevice,
  memberDevices: readonly MemberDevice[],
  ownerDevices: readonly OwnerDevice[],
): string {
  const approver = device.approvedBy;
  if (!approver) {
    return "Approver unavailable";
  }
  if (approver.kind === "invite") {
    return `Approved via invite ${approver.invite_id}`;
  }
  if (approver.kind === "owner") {
    return approver.by === "root"
      ? "Approved with the recovery key"
      : `Approved by owner device ${ownerDevices.find((owner) => owner.deviceFp === approver.by)?.label ?? approver.by}`;
  }
  return `Approved by ${memberDevices.find((member) => member.deviceFp === approver.device_fp)?.label ?? approver.device_fp}`;
}

/** Display-only count; the Gateway owns the actual transitive revocation. */
export function memberDeviceRemovalCount(
  devices: readonly MemberDevice[],
  target: MemberDevice,
): number {
  const removed = new Set([target.peerKey]);
  const pending = [target];
  for (const parent of pending) {
    if (!parent.deviceFp) {
      continue;
    }
    for (const device of devices) {
      if (
        !removed.has(device.peerKey) &&
        device.approvedBy?.kind === "member_device" &&
        device.approvedBy.device_fp === parent.deviceFp
      ) {
        removed.add(device.peerKey);
        pending.push(device);
      }
    }
  }
  return removed.size;
}

/** Display role names consistently in invite summaries and the picker. */
export function roleName(role: string): string {
  return role === "operator" ? "Operator" : role === "viewer" ? "Viewer" : role;
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

/** Decorative initials only; the full reported identity stays beside the avatar. */
export function personInitials(name: string): string {
  return name
    .split("@")[0]!
    .split(/[\s._-]+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase();
}

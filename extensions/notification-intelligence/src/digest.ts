import type { NotificationDigest, TriagedNotification } from "./types.js";

function formatNotificationLine(n: TriagedNotification): string {
  const label = n.appLabel || n.packageName || "Unknown app";
  const parts: string[] = [label];
  if (n.title) parts.push(n.title);
  if (n.text) {
    const truncated = n.text.length > 80 ? `${n.text.substring(0, 80)}...` : n.text;
    parts.push(`"${truncated}"`);
  }
  return `  - ${parts.join(": ")}`;
}

function formatSection(label: string, items: TriagedNotification[], maxShow: number): string {
  if (items.length === 0) return "";
  const lines = [`${label} (${items.length}):`];
  const show = items.slice(0, maxShow);
  for (const n of show) {
    lines.push(formatNotificationLine(n));
  }
  if (items.length > maxShow) {
    lines.push(`  ... and ${items.length - maxShow} more`);
  }
  return lines.join("\n");
}

export function formatDigest(digest: NotificationDigest): string {
  if (digest.totalCount === 0) {
    return "No notifications in the current window.";
  }

  const sections: string[] = [];

  const header = `Notification Digest (${digest.totalCount} total)`;
  sections.push(header);
  sections.push("─".repeat(header.length));

  const critical = formatSection("Critical", digest.critical, 10);
  if (critical) sections.push(critical);

  const important = formatSection("Important", digest.important, 10);
  if (important) sections.push(important);

  const informational = formatSection("Informational", digest.informational, 5);
  if (informational) sections.push(informational);

  if (digest.noise.length > 0) {
    sections.push(`Noise: ${digest.noise.length} low-priority notifications`);
  }

  // Compute unique app count.
  const apps = new Set<string>();
  for (const list of [digest.critical, digest.important, digest.informational, digest.noise]) {
    for (const n of list) {
      apps.add(n.appLabel || n.packageName || "unknown");
    }
  }
  sections.push(`\nFrom ${apps.size} app${apps.size === 1 ? "" : "s"}.`);

  return sections.join("\n\n");
}

export function formatStatus(stats: {
  count: number;
  oldestMs: number | null;
  newestMs: number | null;
}): string {
  if (stats.count === 0) {
    return "Notification Intelligence: no notifications stored.";
  }
  const ageMs = stats.oldestMs ? Date.now() - stats.oldestMs : 0;
  const ageMins = Math.round(ageMs / 60_000);
  return (
    `Notification Intelligence: ${stats.count} notification${stats.count === 1 ? "" : "s"} stored.\n` +
    `Oldest: ${ageMins}m ago.`
  );
}

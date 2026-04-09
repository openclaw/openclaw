import { selectDigestBucketSummaryParts } from "./digest-summary.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function formatSlackDigestSummaryItem(item: unknown): string {
  const record = asRecord(item);
  const layouts = asRecord(record?.digest_bucket_ui_layouts);
  const meta = asRecord(layouts?.meta);
  const summary = selectDigestBucketSummaryParts(item);
  const badge = summary.badge ? asRecord(summary.badge) : asRecord(meta?.badge_parts);
  const leader = summary.leader ? asRecord(summary.leader) : asRecord(meta?.leader_parts);
  const title =
    typeof record?.digest_title === "string"
      ? record.digest_title
      : typeof record?.notification_title_short === "string"
        ? record.notification_title_short
        : typeof record?.notification_group_key === "string"
          ? record.notification_group_key
          : "Digest summary";
  const badgeShort =
    typeof badge?.short === "string"
      ? badge.short
      : typeof record?.digest_bucket_badge_short === "string"
        ? record.digest_bucket_badge_short
        : "UNK";
  const percent = summary.percent ?? "0.0%";
  const leaderText =
    typeof leader?.compact === "string"
      ? leader.compact
      : typeof leader?.label === "string"
        ? leader.label
        : typeof meta?.leader_compact === "string"
          ? meta.leader_compact
          : typeof meta?.leader_label === "string"
            ? meta.leader_label
            : "Follower";
  const shareText = typeof summary.share === "number" ? ` | share=${summary.share}` : "";
  return `${title}\n${badgeShort} | ${percent} | ${leaderText}${shareText}`;
}

export function formatSlackDigestNotification(body: unknown): string | undefined {
  const record = asRecord(body);
  const result = asRecord(record?.result);
  const completion = asRecord(record?.completion);
  const digestSummary = Array.isArray(record?.notification_digest_summary)
    ? record.notification_digest_summary
    : Array.isArray(result?.notification_digest_summary)
      ? result.notification_digest_summary
      : Array.isArray(completion?.notification_digest_summary)
        ? completion.notification_digest_summary
        : undefined;
  if (!digestSummary || digestSummary.length === 0) {
    return undefined;
  }

  const first = formatSlackDigestSummaryItem(digestSummary[0]);
  return digestSummary.length > 1 ? `${first}\n+${digestSummary.length - 1} more` : first;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export type DigestBucketSummaryView = {
  badge: Record<string, unknown> | null;
  leader: Record<string, unknown> | null;
  percent: string | null;
  share: number | null;
};

export function selectDigestBucketSummaryParts(item: unknown): DigestBucketSummaryView {
  const record = asRecord(item);
  const layouts = asRecord(record?.digest_bucket_ui_layouts);
  const meta = asRecord(layouts?.meta);
  const summary = asRecord(meta?.summary_parts);
  if (summary) {
    const display = asRecord(summary.display);
    return {
      badge: asRecord(display?.badge) ?? null,
      leader: asRecord(display?.leader) ?? null,
      percent: typeof summary.percent === "string" ? summary.percent : null,
      share: typeof summary.share === "number" ? summary.share : null,
    };
  }

  const display = asRecord(meta?.display_parts);
  return {
    badge: asRecord(display?.badge) ?? asRecord(meta?.badge_parts) ?? null,
    leader: asRecord(display?.leader) ?? asRecord(meta?.leader_parts) ?? null,
    percent:
      typeof meta?.percent === "string"
        ? meta.percent
        : typeof record?.digest_bucket_percent === "string"
          ? record.digest_bucket_percent
          : null,
    share:
      typeof meta?.share === "number"
        ? meta.share
        : typeof record?.digest_bucket_share === "number"
          ? record.digest_bucket_share
          : null,
  };
}

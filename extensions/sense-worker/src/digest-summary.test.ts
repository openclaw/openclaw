import { describe, expect, it } from "vitest";
import { selectDigestBucketSummaryParts } from "./digest-summary.js";

describe("selectDigestBucketSummaryParts", () => {
  it("prefers summary_parts when present", () => {
    const result = selectDigestBucketSummaryParts({
      digest_bucket_percent: "40.0%",
      digest_bucket_share: 0.4,
      digest_bucket_ui_layouts: {
        meta: {
          summary_parts: {
            display: {
              badge: { label: "Major", short: "MAJ", palette: "warning", order: 3 },
              leader: {
                label: "Leader",
                symbol: "★",
                compact: "Leader ★",
                tokens: ["Leader", "★"],
              },
            },
            percent: "50.0%",
            share: 0.5,
          },
        },
      },
    });

    expect(result).toEqual({
      badge: { label: "Major", short: "MAJ", palette: "warning", order: 3 },
      leader: {
        label: "Leader",
        symbol: "★",
        compact: "Leader ★",
        tokens: ["Leader", "★"],
      },
      percent: "50.0%",
      share: 0.5,
    });
  });

  it("falls back to existing shallow fields only when summary_parts is missing", () => {
    const result = selectDigestBucketSummaryParts({
      digest_bucket_percent: "25.0%",
      digest_bucket_share: 0.25,
      digest_bucket_ui_layouts: {
        meta: {
          display_parts: {
            badge: { label: "Split", short: "SPL", palette: "accent", order: 2 },
            leader: {
              label: "Follower",
              symbol: "",
              compact: "Follower",
              tokens: ["Follower"],
            },
          },
          percent: "30.0%",
          share: 0.3,
        },
      },
    });

    expect(result).toEqual({
      badge: { label: "Split", short: "SPL", palette: "accent", order: 2 },
      leader: {
        label: "Follower",
        symbol: "",
        compact: "Follower",
        tokens: ["Follower"],
      },
      percent: "30.0%",
      share: 0.3,
    });
  });

  it("falls back to top-level percent and share when meta values are missing", () => {
    const result = selectDigestBucketSummaryParts({
      digest_bucket_percent: "12.5%",
      digest_bucket_share: 0.125,
      digest_bucket_ui_layouts: {
        meta: {
          badge_parts: { label: "Minor", short: "MIN", palette: "muted", order: 1 },
          leader_parts: {
            label: "Follower",
            symbol: "",
            compact: "Follower",
            tokens: ["Follower"],
          },
        },
      },
    });

    expect(result).toEqual({
      badge: { label: "Minor", short: "MIN", palette: "muted", order: 1 },
      leader: {
        label: "Follower",
        symbol: "",
        compact: "Follower",
        tokens: ["Follower"],
      },
      percent: "12.5%",
      share: 0.125,
    });
  });
});

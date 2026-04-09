import { describe, expect, it } from "vitest";
import { formatSlackDigestNotification, formatSlackDigestSummaryItem } from "./slack-digest.js";

describe("slack digest formatter", () => {
  it("formats a digest item from summary_parts first", () => {
    const text = formatSlackDigestSummaryItem({
      digest_title: "Auth failures (immediate)",
      digest_bucket_badge_short: "MAJ",
      digest_bucket_ui_layouts: {
        meta: {
          summary_parts: {
            display: {
              badge: { short: "MAJ" },
              leader: { compact: "Leader ★", label: "Leader" },
            },
            percent: "50.0%",
            share: 0.5,
          },
        },
      },
    });

    expect(text).toContain("Auth failures (immediate)");
    expect(text).toContain("MAJ | 50.0% | Leader ★");
    expect(text).toContain("share=0.5");
  });

  it("falls back only when summary_parts is missing", () => {
    const text = formatSlackDigestSummaryItem({
      notification_title_short: "Owner recovery",
      digest_bucket_percent: "25.0%",
      digest_bucket_share: 0.25,
      digest_bucket_badge_short: "SPL",
      digest_bucket_ui_layouts: {
        meta: {
          display_parts: {
            badge: { short: "SPL" },
            leader: { label: "Follower" },
          },
        },
      },
    });

    expect(text).toContain("Owner recovery");
    expect(text).toContain("SPL | 25.0% | Follower");
    expect(text).toContain("share=0.25");
  });

  it("formats a multi-item digest notification without adding a new loop contract", () => {
    const text = formatSlackDigestNotification({
      notification_digest_summary: [
        {
          digest_title: "Auth failures (immediate)",
          digest_bucket_ui_layouts: {
            meta: {
              summary_parts: {
                display: {
                  badge: { short: "MAJ" },
                  leader: { compact: "Leader ★" },
                },
                percent: "50.0%",
                share: 0.5,
              },
            },
          },
        },
        {
          digest_title: "Follow-up retries",
          digest_bucket_ui_layouts: {
            meta: {
              summary_parts: {
                display: {
                  badge: { short: "MIN" },
                  leader: { compact: "Follower" },
                },
                percent: "10.0%",
                share: 0.1,
              },
            },
          },
        },
      ],
    });

    expect(text).toContain("Auth failures (immediate)");
    expect(text).toContain("MAJ | 50.0% | Leader ★");
    expect(text).toContain("+1 more");
  });

  it("reads notification_digest_summary from nested result payloads", () => {
    const text = formatSlackDigestNotification({
      status: "done",
      result: {
        notification_digest_summary: [
          {
            digest_title: "Auth failures (immediate)",
            digest_bucket_ui_layouts: {
              meta: {
                summary_parts: {
                  display: {
                    badge: { short: "MAJ" },
                    leader: { compact: "Leader ★" },
                  },
                  percent: "50.0%",
                  share: 0.5,
                },
              },
            },
          },
        ],
      },
    });

    expect(text).toBe("Auth failures (immediate)\nMAJ | 50.0% | Leader ★ | share=0.5");
  });
});

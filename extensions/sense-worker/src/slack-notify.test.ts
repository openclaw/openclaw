import { describe, expect, it } from "vitest";
import { buildNemoClawSlackText } from "./slack-notify.js";

describe("nemoclaw slack notify", () => {
  it("formats digest_ready from digest payloads", () => {
    const text = buildNemoClawSlackText({
      event: "digest_ready",
      jobId: "job-123",
      payload: {
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

    expect(text).toContain("digest ready (job-123)");
    expect(text).toContain("Auth failures (immediate)");
    expect(text).toContain("MAJ | 50.0% | Leader ★");
  });

  it("formats job_failed with digest and error context", () => {
    const text = buildNemoClawSlackText({
      event: "job_failed",
      jobId: "job-999",
      payload: {
        result: {
          error: "ollama generate failed",
          notification_digest_summary: [
            {
              notification_title_short: "Owner recovery",
              digest_bucket_ui_layouts: {
                meta: {
                  summary_parts: {
                    display: {
                      badge: { short: "SPL" },
                      leader: { compact: "Follower" },
                    },
                    percent: "25.0%",
                    share: 0.25,
                  },
                },
              },
            },
          ],
        },
      },
    });

    expect(text).toContain("job failed (job-999)");
    expect(text).toContain("error=ollama generate failed");
    expect(text).toContain("Owner recovery");
  });

  it("formats job_done without digest using the summary fallback", () => {
    const text = buildNemoClawSlackText({
      event: "job_done",
      jobId: "job-321",
      payload: {
        result: {
          summary: "OpenClaw control log review completed.",
        },
      },
    });

    expect(text).toContain("job done (job-321)");
    expect(text).toContain("OpenClaw control log review completed.");
  });
});

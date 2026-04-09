import { beforeEach, describe, expect, it, vi } from "vitest";

const readLatestNemoClawDigestCacheMock = vi.fn();
const getSenseJobStatusMock = vi.fn();

vi.mock("./latest-digest-cache.js", () => ({
  readLatestNemoClawDigestCache: readLatestNemoClawDigestCacheMock,
}));

vi.mock("./client.js", () => ({
  getSenseJobStatus: getSenseJobStatusMock,
}));

describe("handleNemoClawCommand", () => {
  beforeEach(() => {
    readLatestNemoClawDigestCacheMock.mockReset();
    getSenseJobStatusMock.mockReset();
  });

  it("returns formatted latest digest text", async () => {
    readLatestNemoClawDigestCacheMock.mockResolvedValue({
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
    });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("digest")).resolves.toEqual({
      text: "Auth failures (immediate)\nMAJ | 50.0% | Leader ★ | share=0.5",
    });
  });

  it("returns no-data text when there is no digest", async () => {
    readLatestNemoClawDigestCacheMock.mockResolvedValue(null);
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("digest")).resolves.toEqual({
      text: "No notification_digest_summary available.",
    });
  });

  it("returns formatted digest text for a job with digest summary", async () => {
    getSenseJobStatusMock.mockResolvedValue({
      body: {
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
      },
    });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("job abc-123")).resolves.toEqual({
      text: "Auth failures (immediate)\nMAJ | 50.0% | Leader ★ | share=0.5",
    });
  });

  it("returns minimal summary text for a job without digest summary", async () => {
    getSenseJobStatusMock.mockResolvedValue({
      body: {
        status: "done",
        result: {
          exit_code: 1,
          error: "<urlopen error [Errno 111] Connection refused>",
          summary: "Post-digest-ready-probe failure path check.",
        },
      },
    });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("job 9fb06324")).resolves.toEqual({
      text: "job 9fb06324\nstatus=done\nexit_code=1\nerror=<urlopen error [Errno 111] Connection refused>\nsummary=Post-digest-ready-probe failure path check.",
    });
  });

  it("returns not-found text for an unknown job", async () => {
    getSenseJobStatusMock.mockResolvedValue({
      body: {
        error: "job_not_found",
      },
    });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("job missing-job")).resolves.toEqual({
      text: "job missing-job\nstatus=job_not_found",
    });
  });

  it("returns usage when job id is missing", async () => {
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("job")).resolves.toEqual({
      text: "Usage: /nemoclaw job <id>",
    });
  });
});

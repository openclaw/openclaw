import { beforeEach, describe, expect, it, vi } from "vitest";

const readLatestNemoClawDigestCacheMock = vi.fn();
const getSenseJobStatusMock = vi.fn();
const getRecentSenseJobRefsMock = vi.fn();
const getNemoClawGpuStatusMock = vi.fn();

vi.mock("./latest-digest-cache.js", () => ({
  readLatestNemoClawDigestCache: readLatestNemoClawDigestCacheMock,
}));

vi.mock("./client.js", () => ({
  getSenseJobStatus: getSenseJobStatusMock,
  getRecentSenseJobRefs: getRecentSenseJobRefsMock,
  getNemoClawGpuStatus: getNemoClawGpuStatusMock,
}));

describe("handleNemoClawCommand", () => {
  beforeEach(() => {
    readLatestNemoClawDigestCacheMock.mockReset();
    getSenseJobStatusMock.mockReset();
    getRecentSenseJobRefsMock.mockReset();
    getNemoClawGpuStatusMock.mockReset();
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

  it("returns help text", async () => {
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("help")).resolves.toEqual({
      text:
        "NemoClaw commands\n" +
        "- /nemoclaw digest      latest digest\n" +
        "- /nemoclaw recent      recent jobs\n" +
        "- /nemoclaw failures    recent failed jobs\n" +
        "- /nemoclaw job <id>    show one job\n" +
        "- /nemoclaw gpu         runner and GPU status",
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

  it("returns recent jobs with digest and fallback lines", async () => {
    getRecentSenseJobRefsMock.mockResolvedValue([
      { jobId: "14c197e7-e508-45f1-a28f-eccd49f83c2c", source: "completed" },
      { jobId: "9fb06324-8f9d-4c6b-bac5-57af00bc8207", source: "completed" },
    ]);
    getSenseJobStatusMock
      .mockResolvedValueOnce({
        body: {
          status: "done",
          result: {
            exit_code: 0,
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
      })
      .mockResolvedValueOnce({
        body: {
          status: "done",
          result: {
            exit_code: 1,
            error: "<urlopen error [Errno 111] Connection refused>",
          },
        },
      });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("recent")).resolves.toEqual({
      text:
        "recent jobs\n" +
        "1) 14c197e7... done exit=0\n" +
        "   Auth failures (immediate) | MAJ | 50.0% | Leader ★ | share=0.5\n" +
        "\n" +
        "2) 9fb06324... done exit=1\n" +
        "   error=<urlopen error [Errno 111] Connection refused>",
    });
  });

  it("returns no-data text when there are no recent jobs", async () => {
    getRecentSenseJobRefsMock.mockResolvedValue([]);
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("recent")).resolves.toEqual({
      text: "No recent jobs.",
    });
  });

  it("returns failed jobs only", async () => {
    getRecentSenseJobRefsMock.mockResolvedValue([
      { jobId: "14c197e7-e508-45f1-a28f-eccd49f83c2c", source: "completed" },
      { jobId: "9fb06324-8f9d-4c6b-bac5-57af00bc8207", source: "completed" },
      { jobId: "06be5c75-945f-4c37-b028-45d1d63ddd32", source: "completed" },
    ]);
    getSenseJobStatusMock
      .mockResolvedValueOnce({
        body: {
          status: "done",
          result: {
            exit_code: 0,
            summary: "Healthy job.",
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          status: "done",
          result: {
            exit_code: 1,
            error: "<urlopen error [Errno 111] Connection refused>",
          },
        },
      })
      .mockResolvedValueOnce({
        body: {
          status: "done",
          result: {
            exit_code: 1,
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
    await expect(handleNemoClawCommand("failures")).resolves.toEqual({
      text:
        "failed jobs\n" +
        "1) 9fb06324... done exit=1\n" +
        "   error=<urlopen error [Errno 111] Connection refused>\n" +
        "\n" +
        "2) 06be5c75... done exit=1\n" +
        "   Auth failures (immediate) | MAJ | 50.0% | Leader ★ | share=0.5",
    });
  });

  it("returns no-data text when there are no failed jobs", async () => {
    getRecentSenseJobRefsMock.mockResolvedValue([
      { jobId: "14c197e7-e508-45f1-a28f-eccd49f83c2c", source: "completed" },
    ]);
    getSenseJobStatusMock.mockResolvedValue({
      body: {
        status: "done",
        result: {
          exit_code: 0,
          summary: "Healthy job.",
        },
      },
    });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("failures")).resolves.toEqual({
      text: "No failed jobs.",
    });
  });

  it("returns gpu status text", async () => {
    getNemoClawGpuStatusMock.mockResolvedValue({
      runner: "up",
      worker: "http://192.168.11.11:8787",
      workerHealth: "up",
      model: "gpt-oss:20b",
      gpu: "idle",
    });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("gpu")).resolves.toEqual({
      text:
        "NemoClaw GPU status\n" +
        "- runner: up\n" +
        "- worker: http://192.168.11.11:8787\n" +
        "- worker health: up\n" +
        "- model: gpt-oss:20b\n" +
        "- gpu: idle",
    });
  });

  it("returns unavailable gpu status text", async () => {
    getNemoClawGpuStatusMock.mockResolvedValue({
      runner: "unknown",
      worker: "http://192.168.11.11:8787",
      workerHealth: "unknown",
      gpu: "unavailable",
    });
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("gpu")).resolves.toEqual({
      text:
        "NemoClaw GPU status\n" +
        "- runner: unknown\n" +
        "- worker: http://192.168.11.11:8787\n" +
        "- worker health: unknown\n" +
        "- gpu: unavailable",
    });
  });

  it("returns help text for an unknown subcommand", async () => {
    const { handleNemoClawCommand } = await import("./command.js");
    await expect(handleNemoClawCommand("unknown")).resolves.toEqual({
      text:
        "NemoClaw commands\n" +
        "- /nemoclaw digest      latest digest\n" +
        "- /nemoclaw recent      recent jobs\n" +
        "- /nemoclaw failures    recent failed jobs\n" +
        "- /nemoclaw job <id>    show one job\n" +
        "- /nemoclaw gpu         runner and GPU status",
    });
  });
});

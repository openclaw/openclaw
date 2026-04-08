import { describe, expect, it, vi } from "vitest";
import { createSenseWorkerTool } from "./tool.js";

const { callSenseMock, getSenseJobStatus } = vi.hoisted(() => ({
  callSenseMock: vi.fn(async () => ({
    ok: true,
    status: 200,
    url: "http://sense/execute",
    body: { status: "ok", result: "Sense summary" },
  })),
  getSenseJobStatus: vi.fn(async () => ({
    ok: true,
    status: 200,
    url: "http://sense/jobs/job-123",
    body: {
      status: "ok",
      result: { job_id: "job-123", status: "queued", target: "nemoclaw" },
    },
    job: { job_id: "job-123", status: "queued", target: "nemoclaw" },
  })),
}));

vi.mock("./client.js", () => ({
  checkSenseHealth: vi.fn(async () => ({
    ok: true,
    status: 200,
    url: "http://sense/health",
    body: { status: "ok" },
  })),
  callSense: callSenseMock,
  getSenseJobStatus,
}));

function fakeApi() {
  return {
    pluginConfig: { baseUrl: "http://sense:8787", timeoutMs: 6000 },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as any;
}

describe("sense worker tool", () => {
  it("returns health details", async () => {
    const tool = createSenseWorkerTool(fakeApi());
    const result = await tool.execute("id", { action: "health" });
    expect((result as any).details.status).toBe(200);
    expect((result as any).content[0].text).toContain('"status": "ok"');
  });

  it("returns summarized execute text", async () => {
    callSenseMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "http://sense/execute",
      body: { status: "ok", result: "Sense summary" },
    });
    const tool = createSenseWorkerTool(fakeApi());
    const result = await tool.execute("id", {
      action: "execute",
      task: "summarize",
      input: "hello",
      params: { mode: "short" },
    });
    expect((result as any).content[0].text).toContain("Sense summary");
    expect((result as any).details.url).toContain("/execute");
  });

  it("passes through generate_draft task", async () => {
    callSenseMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "http://sense/execute",
      body: { status: "ok", result: "Sense summary" },
    });
    const tool = createSenseWorkerTool(fakeApi());
    const result = await tool.execute("id", {
      action: "execute",
      task: "generate_draft",
      input: "Write a short follow-up note.",
      params: { tone: "polite" },
    });
    expect((result as any).content[0].text).toContain("Sense summary");
    expect((result as any).details.status).toBe(200);
  });

  it("returns async job status summaries", async () => {
    const tool = createSenseWorkerTool(fakeApi());
    const result = await tool.execute("id", {
      action: "job_status",
      jobId: "job-123",
    });
    expect((result as any).content[0].text).toContain("job-123");
    expect((result as any).content[0].text).toContain("queued");
    expect((result as any).details.job.status).toBe("queued");
  });

  it("prefers summary_parts for digest previews", async () => {
    callSenseMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      url: "http://sense/execute",
      body: {
        notification_digest_summary: [
          {
            notification_group_key: "auth.immediate.full-eval",
            digest_title: "Auth failures (immediate)",
            digest_bucket_percent: "50.0%",
            digest_bucket_share: 0.5,
            digest_bucket_badge_short: "MAJ",
            digest_bucket_ui_layouts: {
              meta: {
                summary_parts: {
                  display: {
                    badge: {
                      label: "Major",
                      short: "MAJ",
                      palette: "warning",
                      order: 3,
                    },
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
          },
        ],
      },
    });

    const tool = createSenseWorkerTool(fakeApi());
    const result = await tool.execute("id", {
      action: "execute",
      task: "summarize",
      input: "digest",
      params: {},
    });

    expect((result as any).content[0].text).toContain("Auth failures (immediate)");
    expect((result as any).content[0].text).toContain("MAJ");
    expect((result as any).content[0].text).toContain("50.0%");
    expect((result as any).content[0].text).toContain("Leader ★");
    expect((result as any).content[0].text).toContain("share=0.5");
  });
});

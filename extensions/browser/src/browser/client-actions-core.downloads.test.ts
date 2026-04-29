import { beforeEach, describe, expect, it, vi } from "vitest";

const clientFetchMocks = vi.hoisted(() => ({
  fetchBrowserJson: vi.fn(async (..._args: unknown[]) => ({
    ok: true,
    targetId: "tab-1",
    download: {
      path: "/tmp/openclaw/downloads/report.pdf",
      suggestedFilename: "report.pdf",
      url: "https://example.com/report.pdf",
    },
  })),
}));

vi.mock("./client-fetch.js", () => clientFetchMocks);

import { browserDownload, browserWaitForDownload } from "./client-actions-core.js";

function readLastFetchOptions() {
  const calls = clientFetchMocks.fetchBrowserJson.mock.calls;
  const options = calls[calls.length - 1]?.[1];
  if (!options || typeof options !== "object") {
    throw new Error("fetchBrowserJson was not called with options");
  }
  return options as { body?: string; timeoutMs?: number };
}

describe("browser download client actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the default download wait timeout for the host client request", async () => {
    await browserDownload(undefined, {
      ref: "e12",
      path: "report.pdf",
    });

    const options = readLastFetchOptions();
    expect(options.timeoutMs).toBe(125_000);
    expect(JSON.parse(options.body ?? "{}")).toEqual({
      ref: "e12",
      path: "report.pdf",
    });
  });

  it("extends the host client request timeout from an explicit download wait", async () => {
    await browserWaitForDownload(undefined, {
      path: "export.csv",
      targetId: "tab-1",
      timeoutMs: 30_000,
      profile: "openclaw",
    });

    expect(clientFetchMocks.fetchBrowserJson).toHaveBeenCalledWith(
      "/wait/download?profile=openclaw",
      expect.objectContaining({
        timeoutMs: 35_000,
      }),
    );
    expect(JSON.parse(readLastFetchOptions().body ?? "{}")).toEqual({
      targetId: "tab-1",
      path: "export.csv",
      timeoutMs: 30_000,
    });
  });
});

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import { parseGitHubLinkParams, parseGitHubReadParams, type GitHubJobTarget } from "./targets.js";

const target: GitHubJobTarget = {
  kind: "job",
  owner: "octocat",
  repo: "reader",
  runId: 39105895701,
  jobId: 117611687309,
};
const repository = "https://api.github.com/repos/octocat/reader";
const jobUrl = `${repository}/actions/jobs/${target.jobId}`;
const url = `https://github.com/octocat/reader/actions/runs/${target.runId}/job/${target.jobId}`;
const storage = "https://productionresultssa10.blob.core.windows.net/logs/job.txt?sig=synthetic";
const token = "synthetic-reader-token";
const revision = "a".repeat(40);
const requestUrl = (input: Parameters<typeof fetch>[0]) =>
  input instanceof Request ? input.url : String(input);
function setup(
  text = "Build started\nTest failed\n",
  overrides: Record<string, unknown> = {},
  response?: Response | Error,
) {
  const state = {
    visible: true,
    selected: true,
    location: storage,
    status: 302,
    revokeOnHead: false,
    privatizeOnDownload: false,
  };
  const bytes = Buffer.from(text);
  const identity = {
    token,
    cacheScope: "job-reader",
    revalidate: async () => {},
    assertSelected: () => {
      if (!state.selected) {
        throw new Error("identity revoked");
      }
    },
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const href = requestUrl(input);
    if (href === repository) {
      return Response.json({
        id: 123,
        private: !state.visible,
        visibility: state.visible ? "public" : "private",
      });
    }
    if (href === jobUrl) {
      return Response.json({
        id: target.jobId,
        run_id: target.runId,
        head_sha: revision,
        url: jobUrl,
        run_url: `${repository}/actions/runs/${target.runId}`,
        name: "check-docs",
        status: "completed",
        conclusion: "failure",
        ...overrides,
      });
    }
    if (href === jobUrl + "/logs") {
      return new Response(null, { status: state.status, headers: { location: state.location } });
    }
    if (href !== storage) {
      throw new Error("unexpected request");
    }
    if (init?.method === "HEAD") {
      state.selected &&= !state.revokeOnHead;
      return new Response(null, { headers: { "content-length": String(bytes.length) } });
    }
    state.visible &&= !state.privatizeOnDownload;
    if (response instanceof Error) {
      throw response;
    }
    const start = Math.max(0, bytes.length - 65536);
    return (
      response ??
      new Response(bytes.subarray(start), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` },
      })
    );
  });
  return { state, fetcher, read: () => loadGitHubDetail(target, identity, fetcher) };
}

describe("public workflow job logs", () => {
  it("accepts public job URLs without changing UI link matching", () => {
    expect(parseGitHubReadParams({ url: url + "#step:3:1", refresh: true })).toEqual({
      target,
      refresh: true,
    });
    expect(parseGitHubLinkParams({ url })).toBeNull();
    for (const invalid of [
      url.replace("github.com", "api.github.com"),
      url.replace("https:", "http:"),
      url.replace("github.com", "user:pass@github.com"),
      url.replace("117611687309", "9007199254740992"),
      url.replace("/job/", "/jobs/"),
      url + "/logs",
      url.replace("octocat", "%6fctocat"),
    ]) {
      expect(parseGitHubReadParams({ url: invalid })).toBeNull();
    }
  });

  it("returns redacted completed-job logs without sending credentials to storage", async () => {
    const f = setup("Failed step\nAuthorization: Bearer synthetic-secret-value-123456789\n");
    const result = await f.read();
    expect(result).toMatchObject({
      title: "check-docs",
      url,
      revision,
      partial: false,
      bodyTruncated: false,
      metadata: expect.arrayContaining([
        { label: "Run", value: "39105895701" },
        { label: "Job", value: "117611687309" },
        { label: "Conclusion", value: "failure" },
      ]),
      body: expect.stringContaining("Failed step"),
    });
    for (const secret of ["synthetic-secret-value-123456789", "sig=synthetic"]) {
      expect(JSON.stringify(result)).not.toContain(secret);
    }
    for (const [input, init] of f.fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      if (requestUrl(input) === storage) {
        expect(headers.has("authorization") || headers.has("cookie")).toBe(false);
        expect(init?.credentials).toBe("omit");
      } else {
        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      }
    }
  });

  it("returns complete tail lines with explicit truncation for large logs", async () => {
    const f = setup("Earlier output\n".repeat(10000) + "\nFinal failure detail\n");
    const result = await f.read();
    expect(result).toMatchObject({ partial: true, bodyTruncated: true });
    for (const text of ["Earlier output is omitted", "Final failure detail"]) {
      expect(result.body).toContain(text);
    }
    const download = f.fetcher.mock.calls.find(
      ([input, init]) => requestUrl(input) === storage && init?.method !== "HEAD",
    );
    expect(new Headers(download?.[1]?.headers).get("range")).toBe("bytes=84486-150021");
  });

  it("keeps built-in token redaction alongside custom logging patterns", async () => {
    await withTempDir("github-job-log-redaction-", async (dir) => {
      const configPath = path.join(dir, "openclaw.json");
      await writeFile(
        configPath,
        JSON.stringify({ logging: { redactPatterns: ["/internal-\\d+/g"] } }),
      );
      const syntheticToken = "ghp_" + "a".repeat(36);
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
        const result = await setup(
          `internal-12345\n${syntheticToken}\nUseful failure detail\n`,
        ).read();
        expect(result.body).toContain("Useful failure detail");
        for (const secret of ["internal-12345", syntheticToken]) {
          expect(result.body).not.toContain(secret);
        }
      });
    });
  });

  it.each([
    { run_id: 1 },
    { id: 1 },
    { head_sha: "unknown" },
    { run_url: "https://api.github.com/repos/elsewhere/private/actions/runs/39105895701" },
    { url: "https://api.github.com/repos/elsewhere/private/actions/jobs/117611687309" },
  ])("rejects mismatched job metadata before downloading: %j", async (metadata) => {
    const f = setup("", metadata);
    await expect(f.read()).rejects.toThrow("different or incomplete workflow job");
    expect(f.fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith("/logs"))).toBe(false);
  });

  it("keeps running jobs distinct from missing logs", async () => {
    const f = setup("", { status: "in_progress", conclusion: null });
    await expect(f.read()).rejects.toThrow("still running");
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["before", "after"])("refuses private repositories %s retrieval", async (phase) => {
    const f = setup();
    f.state.visible = phase !== "before";
    f.state.privatizeOnDownload = true;
    await expect(f.read()).rejects.toMatchObject({ statusCode: 404 });
    if (phase === "before") {
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("revalidates authority between storage metadata and download", async () => {
    const f = setup();
    f.state.revokeOnHead = true;
    await expect(f.read()).rejects.toThrow("identity revoked");
    expect(f.fetcher.mock.calls.filter(([input]) => requestUrl(input) === storage)).toHaveLength(1);
  });

  it.each([
    "https://evil.example/log?sig=synthetic",
    "http://productionresultssa10.blob.core.windows.net/log",
    "https://productionresultssa10.blob.core.windows.net:444/log",
    "https://user:pass@productionresultssa10.blob.core.windows.net/log",
  ])("rejects unsafe storage destinations without disclosure: %s", async (location) => {
    const f = setup();
    f.state.location = location;
    await expect(f.read()).rejects.toThrow("GitHub job logs are unavailable");
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing", undefined],
    [
      "redirect",
      () => new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
    ],
    [
      "range",
      () => new Response("wrong", { status: 206, headers: { "content-range": "bytes 0-4/5" } }),
    ],
    ["oversize", () => new Response("x".repeat(65537))],
    ["transport", () => new Error(storage)],
  ] as const)(
    "reports unavailable %s logs without exposing a signed URL",
    async (failure, response) => {
      const f = setup(undefined, undefined, response?.());
      if (failure === "missing") {
        f.state.status = 404;
      }
      const caught = await f.read().catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).toMatch(/GitHub/);
      expect(String(caught)).not.toContain("sig=synthetic");
    },
  );
});

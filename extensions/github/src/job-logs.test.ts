import { writeFile } from "node:fs/promises";
import path from "node:path";
import { withEnvAsync, withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import { previewFetch, requestUrl } from "./preview.test-support.js";
import { parseGitHubLinkParams, parseGitHubReadParams, type GitHubJobTarget } from "./targets.js";

const target: GitHubJobTarget = {
  kind: "job",
  owner: "octocat",
  repo: "reader",
  runId: 39105895701,
  jobId: 117611687309,
};
const repository = "https://api.github.com/repos/octocat/reader";
const runUrl = `${repository}/actions/runs/${target.runId}`;
const jobUrl = `${repository}/actions/jobs/${target.jobId}`;
const url = `https://github.com/octocat/reader/actions/runs/${target.runId}/job/${target.jobId}`;
const storage = "https://productionresultssa10.blob.core.windows.net/logs/job.txt?sig=synthetic";
const token = "synthetic-reader-token";
const revision = "a".repeat(40);
const logResponse = (body: string | null, status: number, headers: Record<string, string>) =>
  new Response(body, { status, headers });
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
  const fetcher = previewFetch((href, init) => {
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
        run_url: runUrl,
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

  it("redacts default and custom secrets without sending credentials to storage", async () => {
    await withTempDir("github-job-log-redaction-", async (dir) => {
      const config = path.join(dir, "openclaw.json");
      await writeFile(
        config,
        JSON.stringify({ logging: { redactPatterns: ["/internal-\\d+/g"] } }),
      );
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: config }, async () => {
        const bearer = "synthetic-secret-value-123456789";
        const secrets = ["internal-12345", "ghp_" + "a".repeat(36), bearer, "sig=synthetic"];
        const f = setup(
          `${secrets[0]}\n${secrets[1]}\nAuthorization: Bearer ${bearer}\nFailed step\n`,
        );
        const result = await f.read();
        expect(result).toMatchObject({
          title: "check-docs",
          url,
          revision,
          partial: false,
          bodyTruncated: false,
          body: expect.stringContaining("Failed step"),
        });
        for (const secret of secrets) {
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
    });
  });

  const changed = (patch: Partial<ReturnType<typeof setup>["state"]>) => {
    const f = setup();
    Object.assign(f.state, patch);
    return f;
  };
  const incomplete = "different or incomplete workflow job";
  const unavailable = "GitHub job logs are unavailable";
  const badJob = (key: string, value: unknown) => () => setup("", { [key]: value });
  const logs = (response: () => Response | Error) => () => setup(undefined, undefined, response());
  type Failure = [string, () => ReturnType<typeof setup>, string | number, number?];
  const failures: Failure[] = [
    ["run ID", badJob("run_id", 1), incomplete, 2],
    ["job ID", badJob("id", 1), incomplete, 2],
    ["head SHA", badJob("head_sha", "unknown"), incomplete, 2],
    ["run repository", badJob("run_url", runUrl.replace("reader", "private")), incomplete, 2],
    ["job repository", badJob("url", jobUrl.replace("reader", "private")), incomplete, 2],
    ["running", () => setup("", { status: "in_progress", conclusion: null }), "still running", 2],
    ["private before read", () => changed({ visible: false }), 404, 1],
    ["private after download", () => changed({ privatizeOnDownload: true }), 404],
    ["revoked after HEAD", () => changed({ revokeOnHead: true }), "identity revoked", 4],
    ...[
      "https://evil.example/log?sig=synthetic",
      "http://productionresultssa10.blob.core.windows.net/log",
      "https://productionresultssa10.blob.core.windows.net:444/log",
      "https://user:pass@productionresultssa10.blob.core.windows.net/log",
    ].map((location): Failure => [location, () => changed({ location }), unavailable, 3]),
    ["missing", () => changed({ status: 404 }), "GitHub"],
    [
      "redirect",
      logs(() => logResponse(null, 302, { location: "https://evil.example" })),
      "GitHub",
    ],
    ["range", logs(() => logResponse("wrong", 206, { "content-range": "bytes 0-4/5" })), "GitHub"],
    ["oversize", logs(() => new Response("x".repeat(65537))), "GitHub"],
    ["transport", logs(() => new Error(storage)), "GitHub"],
  ];
  it.each(failures)("rejects %s without disclosure", async (_, fixture, error, requests) => {
    const f = fixture();
    const caught = await f.read().catch((failure: unknown) => failure);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).toMatchObject(
      typeof error === "number"
        ? { statusCode: error }
        : { message: expect.stringContaining(error) },
    );
    expect(String(caught)).not.toContain("sig=synthetic");
    if (requests !== undefined) {
      expect(f.fetcher).toHaveBeenCalledTimes(requests);
    }
  });
});

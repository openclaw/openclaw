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
function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : String(input);
}

function setup(text = "Build started\nTest failed\n", overrides: Record<string, unknown> = {}) {
  let current = true;
  let publicRepo = true;
  const bytes = Buffer.from(text);
  const identity = {
    token,
    cacheScope: "job-reader",
    revalidate: async () => {},
    assertSelected: () => {
      if (!current) {
        throw new Error("identity revoked");
      }
    },
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const href = requestUrl(input);
    if (href === repository) {
      return Response.json({
        id: 123,
        private: !publicRepo,
        visibility: publicRepo ? "public" : "private",
      });
    }
    if (href === jobUrl) {
      return Response.json({
        id: target.jobId,
        run_id: target.runId,
        head_sha: "a".repeat(40),
        url: jobUrl,
        run_url: `${repository}/actions/runs/${target.runId}`,
        name: "check-docs",
        status: "completed",
        conclusion: "failure",
        ...overrides,
      });
    }
    if (href === jobUrl + "/logs") {
      return new Response(null, { status: 302, headers: { location: storage } });
    }
    if (href === storage) {
      if (init?.method === "HEAD") {
        return new Response(null, { headers: { "content-length": String(bytes.length) } });
      }
      const start = Math.max(0, bytes.length - 65536);
      return new Response(bytes.subarray(start), {
        status: 206,
        headers: { "content-range": `bytes ${start}-${bytes.length - 1}/${bytes.length}` },
      });
    }
    throw new Error("unexpected request");
  });
  return {
    identity,
    fetcher,
    revoke: () => {
      current = false;
    },
    privatize: () => {
      publicRepo = false;
    },
    read: () => loadGitHubDetail(target, identity, fetcher),
  };
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

  it("returns the completed job identity and redacted log without credentials on storage requests", async () => {
    const fixture = setup("Failed step\nAuthorization: Bearer synthetic-secret-value-123456789\n");
    const result = await fixture.read();
    expect(result).toMatchObject({
      title: "check-docs",
      url,
      revision: "a".repeat(40),
      partial: false,
      bodyTruncated: false,
    });
    expect(result.metadata).toEqual(
      expect.arrayContaining([
        { label: "Run", value: "39105895701" },
        { label: "Job", value: "117611687309" },
        { label: "Conclusion", value: "failure" },
      ]),
    );
    expect(result.body).toContain("Failed step");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-value-123456789");
    expect(JSON.stringify(result)).not.toContain("sig=synthetic");
    for (const [input, init] of fixture.fetcher.mock.calls) {
      const headers = new Headers(init?.headers);
      if (requestUrl(input) === storage) {
        expect(headers.has("authorization")).toBe(false);
        expect(headers.has("cookie")).toBe(false);
        expect(init?.credentials).toBe("omit");
      } else {
        expect(headers.get("authorization")).toBe(`Bearer ${token}`);
      }
    }
  });

  it("returns complete tail lines with explicit truncation for large logs", async () => {
    const fixture = setup("Earlier output\n".repeat(10000) + "\nFinal failure detail\n");
    const result = await fixture.read();
    expect(result).toMatchObject({ partial: true, bodyTruncated: true });
    expect(result.body).toContain("Earlier output is omitted");
    expect(result.body).toContain("Final failure detail");
    const download = fixture.fetcher.mock.calls.find(
      ([input, init]) => requestUrl(input) === storage && init?.method !== "HEAD",
    );
    expect(new Headers(download?.[1]?.headers).get("range")).toBe("bytes=84486-150021");
  });

  it("keeps built-in token redaction when custom logging patterns are configured", async () => {
    await withTempDir("github-job-log-redaction-", async (dir) => {
      const configPath = path.join(dir, "openclaw.json");
      await writeFile(
        configPath,
        JSON.stringify({ logging: { redactPatterns: ["/internal-\\d+/g"] } }),
      );
      const syntheticToken = "ghp_" + "a".repeat(36);
      await withEnvAsync({ OPENCLAW_CONFIG_PATH: configPath }, async () => {
        const fixture = setup(`internal-12345\n${syntheticToken}\nUseful failure detail\n`);
        const result = await fixture.read();
        expect(result.body).toContain("Useful failure detail");
        expect(result.body).not.toContain("internal-12345");
        expect(result.body).not.toContain(syntheticToken);
      });
    });
  });

  it.each([
    { run_id: 1 },
    { id: 1 },
    { head_sha: "unknown" },
    { run_url: "https://api.github.com/repos/elsewhere/private/actions/runs/39105895701" },
    { url: "https://api.github.com/repos/elsewhere/private/actions/jobs/117611687309" },
  ])("rejects mismatched or incomplete job metadata before downloading: %j", async (metadata) => {
    const fixture = setup("", metadata);
    await expect(fixture.read()).rejects.toThrow("different or incomplete workflow job");
    expect(fixture.fetcher.mock.calls.some(([input]) => requestUrl(input).endsWith("/logs"))).toBe(
      false,
    );
  });

  it("keeps running jobs distinct from missing log content", async () => {
    const fixture = setup("", { status: "in_progress", conclusion: null });
    await expect(fixture.read()).rejects.toThrow("still running");
    expect(fixture.fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["before", "after"])("refuses private repositories %s log retrieval", async (phase) => {
    const fixture = setup();
    if (phase === "before") {
      fixture.privatize();
    }
    const upstream = fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation(async (input, init) => {
      const result = await upstream(input, init);
      if (requestUrl(input) === storage && init?.method !== "HEAD") {
        fixture.privatize();
      }
      return result;
    });
    await expect(fixture.read()).rejects.toMatchObject({ statusCode: 404 });
    if (phase === "before") {
      expect(fixture.fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("revalidates selected authority between storage metadata and the log request", async () => {
    const fixture = setup();
    const upstream = fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation(async (input, init) => {
      const result = await upstream(input, init);
      if (init?.method === "HEAD") {
        fixture.revoke();
      }
      return result;
    });
    await expect(fixture.read()).rejects.toThrow("identity revoked");
    expect(
      fixture.fetcher.mock.calls.filter(([input]) => requestUrl(input) === storage),
    ).toHaveLength(1);
  });

  it.each([
    "https://evil.example/log?sig=synthetic",
    "http://productionresultssa10.blob.core.windows.net/log",
    "https://productionresultssa10.blob.core.windows.net:444/log",
    "https://user:pass@productionresultssa10.blob.core.windows.net/log",
  ])("rejects an unsafe download destination without disclosing it: %s", async (location) => {
    const fixture = setup();
    const upstream = fixture.fetcher.getMockImplementation()!;
    fixture.fetcher.mockImplementation((input, init) =>
      requestUrl(input).endsWith("/logs")
        ? Promise.resolve(new Response(null, { status: 302, headers: { location } }))
        : upstream(input, init),
    );
    await expect(fixture.read()).rejects.toThrow("GitHub job logs are unavailable");
    expect(fixture.fetcher).toHaveBeenCalledTimes(3);
  });

  it.each(["missing", "redirect", "range", "oversize", "transport"])(
    "reports unavailable %s logs without exposing a signed URL",
    async (failure) => {
      const fixture = setup();
      const upstream = fixture.fetcher.getMockImplementation()!;
      fixture.fetcher.mockImplementation((input, init) => {
        if (failure === "missing" && requestUrl(input).endsWith("/logs")) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        if (requestUrl(input) === storage && init?.method !== "HEAD") {
          if (failure === "transport") {
            throw new Error(storage);
          }
          if (failure === "redirect") {
            return Promise.resolve(
              new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
            );
          }
          if (failure === "range") {
            return Promise.resolve(
              new Response("wrong", { status: 206, headers: { "content-range": "bytes 0-4/5" } }),
            );
          }
          if (failure === "oversize") {
            return Promise.resolve(new Response("x".repeat(65537)));
          }
        }
        return upstream(input, init);
      });
      const caught = await fixture.read().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(caught).toBeInstanceOf(Error);
      expect(String(caught)).toMatch(/GitHub/);
      expect(String(caught)).not.toContain("sig=synthetic");
    },
  );
});

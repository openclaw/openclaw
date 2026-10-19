import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import type { GitHubTarget } from "./targets.js";

const sha = "a".repeat(40);
const nextSha = "d".repeat(40);
let sequence = 0;
function target(): GitHubTarget {
  return { kind: "pull", owner: "octocat", repo: "checks-" + ++sequence, number: 1 };
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), { status, headers });
}
function pull(headSha: unknown = sha) {
  return {
    title: "Public PR",
    body: "Keep the PR body",
    state: "open",
    created_at: "2026-09-19T12:00:00Z",
    updated_at: "2026-09-19T12:00:00Z",
    comments: 0,
    review_comments: 0,
    changed_files: 0,
    additions: 3,
    deletions: 1,
    head: { sha: headSha, ref: "feature/checks" },
    base: { sha: "b".repeat(40), ref: "main" },
    merge_commit_sha: "c".repeat(40),
  };
}
function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    name: "Build",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    html_url: "https://github.com/octocat/repo/actions/runs/1/job/10",
    ...overrides,
  };
}
function commitStatus(overrides: Record<string, unknown> = {}) {
  return {
    id: 20,
    context: "Deploy",
    state: "success",
    target_url: "https://ci.example.com/build/20",
    ...overrides,
  };
}
function runs(items: unknown[] = [], headers: Record<string, string> = {}) {
  return json({ total_count: items.length, check_runs: items }, 200, headers);
}
function statuses(items: unknown[] = [], commit = sha) {
  return json({ sha: commit, total_count: items.length, statuses: items });
}
function publicFetch(
  checks: Response | (() => Promise<Response>) = runs(),
  legacy = statuses(),
  item = pull(),
) {
  const fetchMock = vi.fn<typeof fetch>();
  const pages = [json({ private: false, visibility: "public" }), json(item), checks, legacy];
  for (const response of pages) {
    fetchMock.mockImplementationOnce(async () =>
      typeof response === "function" ? response() : response,
    );
  }
  return fetchMock;
}
function readChecks(checks: Response, legacy: Response) {
  return loadGitHubDetail(target(), undefined, publicFetch(checks, legacy));
}
function reader(fetchMock: typeof fetch, section?: "checks", input = target()) {
  return (refresh = false, fetchImpl = fetchMock) =>
    loadGitHubDetail(input, undefined, fetchImpl, refresh, section);
}
function expectChecksDocument(
  document: Awaited<ReturnType<typeof loadGitHubDetail>>,
  checks: Record<string, unknown>,
  partial = true,
) {
  expect(document).toMatchObject({ body: "Keep the PR body", partial, checks });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitHub PR checks through the document loader", () => {
  it("coalesces anonymous exact-head CI reads and projects branch/tone facts", async () => {
    vi.stubEnv("GH_TOKEN", "test-ambient-token");
    vi.stubEnv("GITHUB_TOKEN", "test-other-token");
    const input = target();
    const fetchMock = publicFetch(runs([run()]), statuses([commitStatus()]));
    const read = reader(fetchMock, undefined, input);
    const [detail, shared] = await Promise.all([read(), read()]);
    expect(shared).toBe(detail);
    expect(detail).toMatchObject({
      body: "Keep the PR body",
      partial: false,
      checks: {
        state: "success",
        summary: "2 passed",
        total: 2,
        commit: sha,
        truncated: false,
        url: "https://github.com/octocat/" + input.repo + "/pull/1/checks",
        items: [
          { name: "Build", state: "success", detail: "Passed", url: run().html_url },
          { name: "Deploy", state: "success", detail: "Passed", url: commitStatus().target_url },
        ],
      },
      metadata: expect.arrayContaining([
        { label: "Branch", value: "feature/checks → main" },
        { label: "Additions", value: "+3", tone: "positive" },
        { label: "Deletions", value: "−1", tone: "negative" },
      ]),
    });
    const root = "https://api.github.com/repos/octocat/" + input.repo;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      root,
      root + "/pulls/1",
      root + "/commits/" + sha + "/check-runs?filter=latest&per_page=100",
      root + "/commits/" + sha + "/status?per_page=100",
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
      expect(options?.headers).not.toHaveProperty("Cookie");
      expect(options?.redirect).toBe("manual");
    }
  });

  it("orders failed/pending checks ahead of passes and skipped jobs", async () => {
    const result = await readChecks(
      runs([
        run({ id: 1, name: "Build", status: "in_progress", conclusion: null }),
        run({ id: 2, name: "Lint" }),
        run({ id: 3, name: "Optional", conclusion: "skipped" }),
      ]),
      statuses([commitStatus({ state: "failure" })]),
    );
    expect(result.checks).toMatchObject({
      state: "failure",
      summary: "1 failed · 1 pending · 1 passed · 1 skipped or neutral",
      items: [
        { name: "Deploy", state: "failure", detail: "Failed" },
        { name: "Build", state: "pending", detail: "In progress" },
        { name: "Lint", state: "success", detail: "Passed" },
        { name: "Optional", state: "neutral", detail: "Skipped" },
      ],
    });
  });

  it("preserves distinct check run IDs and deduplicates legacy status contexts", async () => {
    const result = await readChecks(
      runs([
        run({ id: 5, conclusion: "failure", check_suite: { id: 1 } }),
        run({ id: 10, check_suite: { id: 2 } }),
        run({ id: 10, check_suite: { id: 2 } }),
      ]),
      statuses([
        commitStatus({ id: 21, context: "build" }),
        commitStatus({ id: 20, context: "BUILD", state: "failure" }),
      ]),
    );
    expect(result.checks).toMatchObject({
      state: "failure",
      total: 3,
      summary: "1 failed · 2 passed",
      truncated: false,
      items: expect.arrayContaining([
        expect.objectContaining({ name: "Build", state: "failure", detail: "Failed" }),
        expect.objectContaining({ name: "build", state: "success", detail: "Passed" }),
        expect.objectContaining({ name: "Build", state: "success", detail: "Passed" }),
      ]),
    });
    expect(result.checks?.items).toHaveLength(3);
  });

  it.each([
    [503, "success", "unavailable", "Checks incomplete · 1 passed", "Passed"],
    [403, "pending", "pending", "Checks incomplete · 1 pending", "Pending"],
  ] as const)(
    "preserves the PR with HTTP %s checks and its sibling",
    async (status, legacy, state, summary, label) => {
      const detail = await readChecks(
        json({ message: "sensitive upstream diagnostic" }, status),
        statuses([commitStatus({ state: legacy })]),
      );
      expectChecksDocument(detail, {
        state,
        summary,
        total: 1,
        truncated: true,
        items: [{ state: legacy, detail: label }],
      });
      expect(JSON.stringify(detail)).not.toContain("sensitive upstream");
    },
  );

  it("refreshes a cached failed checks section for the same head", async () => {
    const read = reader(publicFetch(json({}, 503), statuses()), "checks");
    const failed = await read();
    expect(failed).toMatchObject({
      revision: sha,
      partial: true,
      checks: { state: "unavailable", truncated: true },
    });
    const recoveredFetch = publicFetch(runs([run()]), statuses());
    expect(await read(false, recoveredFetch)).toBe(failed);
    expect(recoveredFetch).not.toHaveBeenCalled();
    const recovered = await read(true, recoveredFetch);
    expect(recovered).toMatchObject({
      revision: sha,
      partial: false,
      checks: { state: "success", commit: sha, truncated: false, total: 1 },
    });
    expect(recoveredFetch).toHaveBeenCalledTimes(4);
  });

  it("honors anonymous quota cooldown without losing the body or spending requests", async () => {
    const fetchMock = publicFetch(json({}, 429, { "retry-after": "60" }));
    const read = reader(fetchMock);
    const first = await read();
    expectChecksDocument(first, {
      state: "unavailable",
      summary: "Checks unavailable",
      items: [],
    });
    expect(await read()).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, "../main"])(
    "rejects invalid head %s without substituting branch or merge SHA",
    async (headSha) => {
      const fetchMock = publicFetch(runs(), statuses(), {
        ...pull(),
        head: { sha: headSha, ref: "feature/checks" },
      });
      const detail = await loadGitHubDetail(target(), undefined, fetchMock);
      expectChecksDocument(detail, { state: "unavailable", items: [] });
      expect(detail.checks?.commit).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["wrong check SHA", () => runs([run({ head_sha: nextSha })]), () => statuses()],
    ["wrong status SHA", () => runs(), () => statuses([commitStatus()], nextSha)],
    ["unknown conclusion", () => runs([run({ conclusion: "mystery" })]), () => statuses()],
  ] as const)("never reports success for %s", async (_, check, legacy) => {
    const result = await readChecks(check(), legacy());
    expectChecksDocument(result, { state: "unavailable", truncated: true, items: [] });
  });

  it("bounds pages, final items, and labels without following untrusted pagination", async () => {
    const fetchMock = publicFetch(
      runs(
        Array.from({ length: 110 }, (_, id) => run({ id, name: id + "x".repeat(300) })),
        { Link: '<https://example.com/never-fetch>; rel="next"' },
      ),
      statuses([commitStatus()]),
    );
    const result = await loadGitHubDetail(target(), undefined, fetchMock);
    expectChecksDocument(result, { state: "unavailable", total: 111, truncated: true });
    expect(result.checks?.items).toHaveLength(100);
    expect(result.checks?.items.every((item) => item.name.length <= 256)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each(["http://ci.example.com/log", "https://user:password@ci.example.com/log"])(
    "omits unsafe check and status links: %s",
    async (url) => {
      const result = await readChecks(
        runs([run({ html_url: url })]),
        statuses([commitStatus({ target_url: url })]),
      );
      expect(result.checks?.items).toMatchObject([{ url: undefined }, { url: undefined }]);
    },
  );

  it("does not let a late old-head read overwrite the refreshed document cache", async () => {
    const deferred = createDeferred<Response>();
    const requested = createDeferred<void>();
    const fetchMock = publicFetch(() => {
      requested.resolve();
      return deferred.promise;
    });
    const read = reader(fetchMock);
    const older = read();
    await requested.promise;
    const freshFetch = publicFetch(
      runs([run({ head_sha: nextSha, conclusion: "failure" })]),
      statuses([], nextSha),
      pull(nextSha),
    );
    const fresh = await read(true, freshFetch);
    deferred.resolve(runs([run()]));
    expect((await older).checks).toMatchObject({ state: "success", commit: sha });
    expect(fresh.checks).toMatchObject({ state: "failure", commit: nextSha });
    expect(await read()).toBe(fresh);
    expect(freshFetch).toHaveBeenCalledTimes(4);
  });

  it("expires complete PR snapshots after 30 seconds, not five minutes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const fetchMock = publicFetch();
    const read = reader(fetchMock);
    const first = await read();
    now.mockReturnValue(30_999);
    expect(await read()).toBe(first);
    fetchMock.mockImplementation(publicFetch(runs([run()])));
    now.mockReturnValue(31_001);
    expect((await read()).checks?.state).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});

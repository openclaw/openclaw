import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import { githubJson as json, previewPayload, queuedFetch } from "./preview.test-support.js";
import type { GitHubTarget } from "./targets.js";

const sha = "a".repeat(40);
const nextSha = "d".repeat(40);
let sequence = 0;
function target(): GitHubTarget {
  return { kind: "pull", owner: "octocat", repo: "checks-" + ++sequence, number: 1 };
}
function pull(headSha: unknown = sha) {
  return previewPayload({
    body: "Keep the PR body",
    comments: 0,
    review_comments: 0,
    changed_files: 0,
    head: { sha: headSha, ref: "feature/checks" },
    base: { sha: "b".repeat(40), ref: "main" },
    merge_commit_sha: "c".repeat(40),
  });
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
  return queuedFetch(json({ private: false, visibility: "public" }), json(item), checks, legacy);
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
  it("coalesces anonymous exact-head reads", async () => {
    vi.stubEnv("GH_TOKEN", "test-ambient-token");
    vi.stubEnv("GITHUB_TOKEN", "test-other-token");
    const input = target();
    const fetchMock = publicFetch(runs([run()]), statuses([commitStatus()]));
    const read = reader(fetchMock, undefined, input);
    const [detail, shared] = await Promise.all([read(), read()]);
    expect(shared).toBe(detail);
    expectChecksDocument(
      detail,
      {
        url: `https://github.com/octocat/${input.repo}/pull/1/checks`,
        items: [{ url: run().html_url }, { url: commitStatus().target_url, detail: "Passed" }],
      },
      false,
    );
    expect(detail.metadata).toContainEqual({ label: "Branch", value: "feature/checks → main" });
    const commitUrl = `https://api.github.com/repos/octocat/${input.repo}/commits/${sha}`;
    expect(fetchMock.mock.calls.slice(2).map(([url]) => url)).toEqual([
      `${commitUrl}/check-runs?filter=latest&per_page=100`,
      `${commitUrl}/status?per_page=100`,
    ]);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
      expect(options?.headers).not.toHaveProperty("Cookie");
      expect(options?.redirect).toBe("manual");
    }
  });

  it("deduplicates run IDs and status contexts, then orders checks by severity", async () => {
    const result = await readChecks(
      runs([
        run({ id: 1, status: "in_progress", conclusion: null, check_suite: { id: 1 } }),
        run({ id: 2, name: "Build", check_suite: { id: 2 } }),
        run({ id: 2, name: "Build", check_suite: { id: 2 } }),
        run({ id: 3, name: "Optional", conclusion: "skipped" }),
      ]),
      statuses([
        commitStatus({ id: 21, context: "Deploy", state: "failure" }),
        commitStatus({ id: 20, context: "DEPLOY" }),
      ]),
    );
    expect(result.checks).toMatchObject({
      state: "failure",
      total: 4,
      truncated: false,
      summary: "1 failed · 1 pending · 1 passed · 1 skipped or neutral",
      items: [
        { name: "Deploy", state: "failure", detail: "Failed" },
        { name: "Build", state: "pending", detail: "In progress" },
        { name: "Build", state: "success", detail: "Passed" },
        { name: "Optional", state: "neutral", detail: "Skipped" },
      ],
    });
    expect(result.checks?.items).toHaveLength(4);
  });

  it.each([
    [503, "success", "unavailable", "Checks incomplete · 1 passed", "Passed"],
    [403, "pending", "pending", "Checks incomplete · 1 pending", "Pending"],
  ] as const)("keeps the PR after HTTP %s", async (status, legacy, state, summary, label) => {
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

  it.each([undefined, "../main"])("rejects invalid head %s", async (headSha) => {
    const fetchMock = publicFetch(runs(), statuses(), {
      ...pull(),
      head: { sha: headSha, ref: "feature/checks" },
    });
    const detail = await loadGitHubDetail(target(), undefined, fetchMock);
    expectChecksDocument(detail, { state: "unavailable", items: [] });
    expect(detail.checks?.commit).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

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
    "omits unsafe URL %s",
    async (url) => {
      const result = await readChecks(
        runs([run({ html_url: url })]),
        statuses([commitStatus({ target_url: url })]),
      );
      expect(result.checks?.items).toMatchObject([{ url: undefined }, { url: undefined }]);
    },
  );

  it("keeps refreshed failures over late reads, then recovers and expires them", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const deferred = createDeferred<Response>();
    const requested = createDeferred<void>();
    const read = reader(
      publicFetch(() => {
        requested.resolve();
        return deferred.promise;
      }),
      "checks",
    );
    const older = read();
    await requested.promise;
    const failed = await read(
      true,
      publicFetch(json({}, 503), statuses([], nextSha), pull(nextSha)),
    );
    expect(failed).toMatchObject({
      revision: nextSha,
      partial: true,
      checks: { state: "unavailable", truncated: true },
    });
    deferred.resolve(runs([run()]));
    expect((await older).checks).toMatchObject({ state: "success", commit: sha });
    const recovery = publicFetch(
      runs([run({ head_sha: nextSha, conclusion: "failure" })]),
      statuses([], nextSha),
      pull(nextSha),
    );
    expect(await read(false, recovery)).toBe(failed);
    expect(recovery).not.toHaveBeenCalled();
    const fresh = await read(true, recovery);
    expect(fresh).toMatchObject({
      revision: nextSha,
      partial: false,
      checks: { state: "failure", commit: nextSha, truncated: false, total: 1 },
    });
    now.mockReturnValue(30_999);
    expect(await read()).toBe(fresh);
    now.mockReturnValue(31_001);
    expect(await read(false, publicFetch())).not.toBe(fresh);
  });
});

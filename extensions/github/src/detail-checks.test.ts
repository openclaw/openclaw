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
    app: { id: 1 },
    check_suite: { id: 1 },
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
  return json({
    sha: commit,
    state: items.length ? "success" : "pending",
    total_count: items.length,
    statuses: items,
  });
}
function publicFetch(checks = runs(), legacy = statuses(), headSha: unknown = sha) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ private: false, visibility: "public" }))
    .mockResolvedValueOnce(json(pull(headSha)))
    .mockResolvedValueOnce(checks)
    .mockResolvedValueOnce(legacy);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitHub PR checks through the document loader", () => {
  it("reads both anonymous CI sources for the exact head, projects branch/tone facts, and coalesces reads", async () => {
    vi.stubEnv("GH_TOKEN", "test-ambient-token");
    vi.stubEnv("GITHUB_TOKEN", "test-other-token");
    const input = target();
    const fetchMock = publicFetch(runs([run()]), statuses([commitStatus()]));
    const [detail, shared] = await Promise.all([
      loadGitHubDetail(input, undefined, fetchMock),
      loadGitHubDetail(input, undefined, fetchMock),
    ]);
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

  it("treats complete empty CI as neutral despite the legacy API's empty pending aggregate", async () => {
    const detail = await loadGitHubDetail(target(), undefined, publicFetch());
    expect(detail).toMatchObject({
      partial: false,
      checks: {
        state: "neutral",
        summary: "No checks reported",
        total: 0,
        items: [],
        truncated: false,
      },
    });
  });

  it.each([
    ["completed", "success", "success", "Passed"],
    ["completed", "failure", "failure", "Failed"],
    ["completed", "cancelled", "failure", "Canceled"],
    ["completed", "timed_out", "failure", "Timed out"],
    ["completed", "action_required", "failure", "Action required"],
    ["completed", "stale", "failure", "Stale"],
    ["completed", "startup_failure", "failure", "Could not start"],
    ["completed", "neutral", "neutral", "Neutral"],
    ["completed", "skipped", "neutral", "Skipped"],
    ["queued", null, "pending", "Queued"],
    ["in_progress", null, "pending", "In progress"],
    ["waiting", null, "pending", "Waiting"],
    ["requested", null, "pending", "Waiting"],
    ["pending", null, "pending", "Waiting"],
  ])("projects check %s/%s as %s", async (status, conclusion, state, detail) => {
    const result = await loadGitHubDetail(
      target(),
      undefined,
      publicFetch(runs([run({ status, conclusion })])),
    );
    expect(result).toMatchObject({ partial: false, checks: { state, items: [{ state, detail }] } });
  });

  it.each([
    ["success", "success", "Passed"],
    ["failure", "failure", "Failed"],
    ["error", "failure", "Error"],
    ["pending", "pending", "Pending"],
  ])("projects legacy %s as %s", async (raw, state, detail) => {
    const result = await loadGitHubDetail(
      target(),
      undefined,
      publicFetch(runs(), statuses([commitStatus({ state: raw })])),
    );
    expect(result).toMatchObject({ partial: false, checks: { state, items: [{ state, detail }] } });
  });

  it("prioritizes failed then pending checks without treating skipped jobs as passes", async () => {
    const result = await loadGitHubDetail(
      target(),
      undefined,
      publicFetch(
        runs([
          run({ id: 1, name: "Build", status: "in_progress", conclusion: null }),
          run({ id: 2, name: "Lint" }),
          run({ id: 3, name: "Optional", conclusion: "skipped" }),
        ]),
        statuses([commitStatus({ state: "failure" })]),
      ),
    );
    expect(result.checks).toMatchObject({
      state: "failure",
      summary: "1 failed · 1 pending · 1 passed · 1 skipped or neutral",
    });
    expect(result.checks?.items.map((item) => item.state)).toEqual([
      "failure",
      "pending",
      "success",
      "neutral",
    ]);
  });

  it("retains an independent failed check when another suite has a newer successful check with the same app and name", async () => {
    const result = await loadGitHubDetail(
      target(),
      undefined,
      publicFetch(
        runs([
          run({ id: 501, name: "Build", conclusion: "failure", check_suite: { id: 101 } }),
          run({ id: 502, name: "Build", conclusion: "success", check_suite: { id: 102 } }),
        ]),
      ),
    );
    expect(result.checks).toMatchObject({
      state: "failure",
      summary: "1 failed · 1 passed",
      total: 2,
      truncated: false,
      items: [
        { name: "Build", state: "failure" },
        { name: "Build", state: "success" },
      ],
    });
  });

  it("preserves distinct check run IDs and deduplicates legacy status contexts", async () => {
    const result = await loadGitHubDetail(
      target(),
      undefined,
      publicFetch(
        runs([
          run({ id: 5, conclusion: "failure", check_suite: { id: 1 } }),
          run({ id: 10, check_suite: { id: 2 } }),
          run({ id: 10, check_suite: { id: 2 } }),
        ]),
        statuses([
          commitStatus({ id: 21, context: "build" }),
          commitStatus({ id: 20, context: "BUILD", state: "failure" }),
        ]),
      ),
    );
    expect(result.checks).toMatchObject({
      state: "failure",
      total: 3,
      summary: "1 failed · 2 passed",
      truncated: false,
    });
    expect(result.checks?.items).toHaveLength(3);
    expect(result.checks?.items.map((item) => [item.name, item.state])).toEqual(
      expect.arrayContaining([
        ["Build", "failure"],
        ["build", "success"],
        ["Build", "success"],
      ]),
    );
  });

  it.each(["runs", "statuses"])(
    "preserves the PR and successful sibling when %s is unavailable",
    async (source) => {
      const fetchMock =
        source === "runs"
          ? publicFetch(
              json({ message: "sensitive upstream diagnostic" }, 503),
              statuses([commitStatus()]),
            )
          : publicFetch(runs([run()]), json({ message: "sensitive upstream diagnostic" }, 404));
      const detail = await loadGitHubDetail(target(), undefined, fetchMock);
      expect(detail).toMatchObject({
        body: "Keep the PR body",
        partial: true,
        checks: {
          state: "unavailable",
          summary: "Checks incomplete · 1 passed",
          total: 1,
          truncated: true,
        },
      });
      expect(detail.checks?.items).toHaveLength(1);
      expect(JSON.stringify(detail)).not.toContain("sensitive upstream");
    },
  );

  it("does not collapse same-name checks whose app identity is unavailable", async () => {
    const result = await loadGitHubDetail(
      target(),
      undefined,
      publicFetch(
        runs([run({ id: 1, app: null, conclusion: "failure" }), run({ id: 2, app: null })]),
      ),
    );
    expect(result.checks).toMatchObject({ state: "failure", total: 2 });
    expect(result.checks?.items).toHaveLength(2);
  });

  it.each(["failure", "pending"])("retains known %s above incomplete data", async (state) => {
    const result = await loadGitHubDetail(
      target(),
      undefined,
      publicFetch(json({}, 403), statuses([commitStatus({ state })])),
    );
    expect(result).toMatchObject({
      partial: true,
      checks: { state, truncated: true, summary: expect.stringMatching(/^Checks incomplete/u) },
    });
  });

  it("honors anonymous quota cooldown, preserves the body, and does not spend another request", async () => {
    const fetchMock = publicFetch(json({}, 429, { "retry-after": "60" }));
    const input = target();
    const first = await loadGitHubDetail(input, undefined, fetchMock);
    expect(first).toMatchObject({
      body: "Keep the PR body",
      partial: true,
      checks: { state: "unavailable", summary: "Checks unavailable", items: [] },
    });
    expect(await loadGitHubDetail(input, undefined, fetchMock)).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it.each([undefined, null, "main", "abcdef0", "../main", "a".repeat(41)])(
    "does not substitute a branch or merge SHA for invalid head %s",
    async (headSha) => {
      const fetchMock = publicFetch();
      fetchMock
        .mockReset()
        .mockResolvedValueOnce(json({ private: false, visibility: "public" }))
        .mockResolvedValueOnce(json({ ...pull(), head: { sha: headSha, ref: "feature/checks" } }));
      const detail = await loadGitHubDetail(target(), undefined, fetchMock);
      expect(detail).toMatchObject({
        body: "Keep the PR body",
        partial: true,
        checks: { state: "unavailable", items: [] },
      });
      expect(detail.checks?.commit).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {
      name: "wrong check SHA",
      check: () => runs([run({ head_sha: nextSha })]),
      legacy: () => statuses(),
    },
    {
      name: "wrong status SHA",
      check: () => runs(),
      legacy: () => statuses([commitStatus()], nextSha),
    },
    {
      name: "unknown conclusion",
      check: () => runs([run({ conclusion: "mystery" })]),
      legacy: () => statuses(),
    },
    {
      name: "malformed list",
      check: () => json({ total_count: 0, check_runs: null }),
      legacy: () => statuses(),
    },
    {
      name: "oversized response",
      check: () => new Response("x".repeat(1024 * 1024 + 1)),
      legacy: () => statuses(),
    },
  ])("never reports success for $name", async ({ check, legacy }) => {
    const result = await loadGitHubDetail(target(), undefined, publicFetch(check(), legacy()));
    expect(result).toMatchObject({
      body: "Keep the PR body",
      partial: true,
      checks: { state: "unavailable", truncated: true, items: [] },
    });
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
    expect(result).toMatchObject({
      partial: true,
      checks: { state: "unavailable", total: 111, truncated: true },
    });
    expect(result.checks?.items).toHaveLength(100);
    expect(result.checks?.items.every((item) => item.name.length <= 256)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    "javascript:alert(1)",
    "http://ci.example.com/log",
    "https://user:password@ci.example.com/log",
  ])("omits unsafe check and status links: %s", async (url) => {
    const result = await loadGitHubDetail(
      target(),
      undefined,
      publicFetch(runs([run({ html_url: url })]), statuses([commitStatus({ target_url: url })])),
    );
    expect(result.checks?.items).toHaveLength(2);
    expect(result.checks?.items.every((item) => item.url === undefined)).toBe(true);
  });

  it("refreshes the exact PR head and rechecks a changed result even within the cache TTL", async () => {
    const input = target();
    const fetchMock = publicFetch(runs([run()]));
    await loadGitHubDetail(input, undefined, fetchMock);
    fetchMock
      .mockResolvedValueOnce(json({ private: false, visibility: "public" }))
      .mockResolvedValueOnce(json(pull(nextSha)))
      .mockResolvedValueOnce(runs([run({ head_sha: nextSha, status: "queued", conclusion: null })]))
      .mockResolvedValueOnce(statuses([], nextSha));
    const refreshed = await loadGitHubDetail(input, undefined, fetchMock, true);
    expect(refreshed.checks).toMatchObject({ commit: nextSha, state: "pending" });
    expect(await loadGitHubDetail(input, undefined, fetchMock)).toBe(refreshed);
    expect(fetchMock.mock.calls.slice(6).map(([url]) => url)).toEqual([
      expect.stringContaining("/commits/" + nextSha + "/check-runs?"),
      expect.stringContaining("/commits/" + nextSha + "/status?"),
    ]);
    fetchMock
      .mockResolvedValueOnce(json({ private: false, visibility: "public" }))
      .mockResolvedValueOnce(json(pull(nextSha)))
      .mockResolvedValueOnce(runs([run({ head_sha: nextSha })]))
      .mockResolvedValueOnce(statuses([], nextSha));
    expect((await loadGitHubDetail(input, undefined, fetchMock, true)).checks).toMatchObject({
      commit: nextSha,
      state: "success",
    });
  });

  it("does not let a late old-head read overwrite the refreshed document cache", async () => {
    const input = target();
    const deferred = createDeferred<Response>();
    const requested = createDeferred<void>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (url) => {
      const path = new URL(url instanceof Request ? url.url : url).pathname;
      if (path.endsWith("/pulls/1")) {
        return json(pull());
      }
      if (path.endsWith("/check-runs")) {
        requested.resolve();
        return deferred.promise;
      }
      if (path.endsWith("/status")) {
        return statuses();
      }
      return json({ private: false, visibility: "public" });
    });
    const older = loadGitHubDetail(input, undefined, fetchMock);
    await requested.promise;
    const freshFetch = publicFetch(
      runs([run({ head_sha: nextSha, conclusion: "failure" })]),
      statuses([], nextSha),
      nextSha,
    );
    const fresh = await loadGitHubDetail(input, undefined, freshFetch, true);
    deferred.resolve(runs([run()]));
    expect((await older).checks).toMatchObject({ state: "success", commit: sha });
    expect(fresh.checks).toMatchObject({ state: "failure", commit: nextSha });
    expect(await loadGitHubDetail(input, undefined, fetchMock)).toBe(fresh);
    expect(freshFetch).toHaveBeenCalledTimes(4);
  });

  it("expires complete PR snapshots after 30 seconds rather than keeping checks for five minutes", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    const input = target();
    const fetchMock = publicFetch();
    const first = await loadGitHubDetail(input, undefined, fetchMock);
    now.mockReturnValue(30_999);
    expect(await loadGitHubDetail(input, undefined, fetchMock)).toBe(first);
    fetchMock
      .mockResolvedValueOnce(json({ private: false, visibility: "public" }))
      .mockResolvedValueOnce(json(pull()))
      .mockResolvedValueOnce(runs([run()]))
      .mockResolvedValueOnce(statuses());
    now.mockReturnValue(31_001);
    expect((await loadGitHubDetail(input, undefined, fetchMock)).checks?.state).toBe("success");
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });
});

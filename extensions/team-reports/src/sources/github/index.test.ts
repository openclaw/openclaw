import { afterEach, expect, it, vi } from "vitest";
import { bindReportFetch, type ReportFixtureFetch } from "../../report-network.test-support.js";
import type { GithubItem } from "../../types.js";
import { createGithubSource } from "./index.js";
import {
  advisory,
  at,
  commit,
  config,
  emptyRoute,
  issue,
  issuesUpdatedAfterWindow,
  json,
  logger,
  repo,
  roster,
  sinceMs,
  untilMs,
  window,
} from "./responses.fixtures.js";

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;
function source(routes: Route | Record<string, Route> = emptyRoute) {
  const logs = { ...logger, info: vi.fn() };
  const fetchImpl = vi.fn<ReportFixtureFetch>((input, init) => {
    const url = new URL(input);
    const route = typeof routes === "function" ? routes : (routes[url.pathname] ?? emptyRoute);
    return Promise.resolve(route(url, init));
  });
  const streaming = bindReportFetch(createGithubSource({ logger: logs }), fetchImpl);
  return {
    streaming,
    api: {
      ...streaming,
      async collect(sourceConfig = config) {
        const items: GithubItem[] = [];
        const status = await streaming.collect(sourceConfig, window, roster, async (entries) => {
          items.push(...entries.map(({ value }) => value));
        });
        return { items, status };
      },
    },
    fetchImpl,
    requests: (path: string) =>
      fetchImpl.mock.calls.map(([input]) => new URL(input)).filter((url) => url.pathname === path),
    logs,
  };
}

function page(data: unknown, url: URL) {
  return json(data, { Link: `<${url}&page=2>; rel="next"` });
}

function searchResult(items: unknown[]) {
  return json({ total_count: items.length, items });
}

function comment(body: string | null, index = 1, created_at = at) {
  return {
    user: { login: "reviewer" },
    body,
    created_at,
    html_url: `https://github.test/comment/${index}`,
  };
}

const old = "2026-08-01T00:00:00Z";
const exclusionConfig = { ...config, excludeRepos: ["example/excluded"] };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("emits attributed commits and awaits writes before fetching the next page", async () => {
  const firstWrite = Promise.withResolvers<void>();
  const releaseWrite = Promise.withResolvers<void>();
  const batchSizes: number[] = [];
  let first: GithubItem | undefined;
  const attributed = commit(
    "0",
    "Fix parsing\n\nCo-authored-by: @reviewer <r@example.test>\nCo-authored-by: Helper Name <123+helper@users.noreply.github.com>\nCo-authored-by: reviewer <r@example.test>\nCo-authored-by: Unknown Person <x@example.test>\nCo-authored-by: stranger <x@example.test>\nCo-authored-by: Guest Person <456+guest@users.noreply.github.com>\nCo-authored-by: @visitor <v@example.test>",
  );
  let pages = 0;
  const { streaming } = source((url) => {
    if (url.pathname === "/repos/example/app/commits") {
      pages++;
      return pages === 1
        ? page(
            Array.from({ length: 100 }, (_, index) =>
              index === 0 ? attributed : commit(String(index)),
            ),
            url,
          )
        : json([commit("last")]);
    }
    return emptyRoute(url);
  });
  const pending = streaming.collect(config, window, roster, async (entries) => {
    first ??= entries[0]?.value;
    batchSizes.push(entries.length);
    if (batchSizes.length === 1) {
      firstWrite.resolve();
      await releaseWrite.promise;
    }
  });
  try {
    await Promise.race([firstWrite.promise, pending]);
    expect([pages, batchSizes]).toEqual([1, [100]]);
  } finally {
    releaseWrite.resolve();
  }
  expect(await pending).toMatchObject({ ok: true, stats: { commitStrategy: "per-repo" } });
  expect(first).toMatchObject({
    kind: "commit",
    actor: "builder",
    title: "Fix parsing",
    coauthors: ["guest", "helper", "reviewer", "visitor"],
  });
  expect([pages, batchSizes]).toEqual([2, [100, 1]]);
});

it.each([
  ["/commits", 409, "Git Repository is empty.", true],
  ["/commits", 409, "Conflict", false],
  ["/commits", 403, "Git Repository is empty.", false],
  ["/issues/comments", 409, "Git Repository is empty.", false],
] as const)(
  "qualifies empty-repository responses from %s with HTTP %s (%s)",
  async (endpoint, httpStatus, message, ok) => {
    const { api } = source((url) =>
      url.pathname === `/repos/example/app${endpoint}`
        ? json({ message }, {}, httpStatus)
        : emptyRoute(url),
    );
    const result = await api.collect();
    expect(result.items).toEqual([]);
    expect(result.status.ok).toBe(ok);
    expect(result.status.warnings).toHaveLength(ok ? 0 : 1);
  },
);

it("paginates GHES teams and filters direct collaborators to eligible write access", async () => {
  const { api, fetchImpl } = source((url, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/vnd.github+json");
    expect(headers.get("x-github-api-version")).toBe("2022-11-28");
    if (url.pathname.endsWith("/members")) {
      expect(url.pathname).toBe("/api/v3/orgs/example/teams/builders/members");
      return url.searchParams.has("page")
        ? json([{ login: "reviewer" }])
        : json([{ login: "builder" }], { Link: '<?page=2&per_page=100>; rel="next"' });
    }
    if (url.pathname.endsWith("/repos")) {
      return json([repo(), repo("old", true), repo("excluded")]);
    }
    if (url.pathname.endsWith("/collaborators")) {
      expect(url.searchParams.get("affiliation")).toBe("direct");
      return json([
        { login: "helper", permissions: { push: true } },
        { login: "owner", permissions: { admin: true } },
        { login: "maintainer", permissions: { maintain: true } },
        { login: "reader", permissions: { pull: true } },
      ]);
    }
    throw new Error("Unexpected request");
  });
  const result = await api.loadRoster({
    ...exclusionConfig,
    apiBaseUrl: "https://github.test/api/v3",
    includeDirectCollaborators: true,
  });
  expect(result.status.ok).toBe(true);
  expect(result.people.map((person) => person.github[0])).toEqual([
    "builder",
    "helper",
    "maintainer",
    "owner",
    "reviewer",
  ]);
  expect(
    fetchImpl.mock.calls.filter(([url]) => String(url).includes("/collaborators")),
  ).toHaveLength(1);
});

it.each([
  ["created", "pull-request"],
  ["updated", "issue"],
])(
  "splits and paginates capped %s is:%s searches, warns on incomplete results and deduplicates PR lookups",
  async (qualifier, type) => {
    vi.spyOn(Date, "now").mockReturnValue(untilMs);
    const merged = issuesUpdatedAfterWindow.merged;
    const oldMerge = {
      ...issue(3),
      created_at: "2026-08-19T00:00:00Z",
      pull_request: { merged_at: "2026-08-19T01:00:00Z" },
      closed_at: "2026-08-19T01:00:00Z",
    };
    const pages = [
      () => json({ total_count: 1000, items: [] }),
      (url: URL) => page({ total_count: 3, items: [type === "issue" ? issue() : merged] }, url),
      () =>
        json({
          total_count: 3,
          incomplete_results: true,
          items: type === "issue" ? [issue()] : [oldMerge, merged],
        }),
    ];
    const { api, requests } = source({
      "/search/issues": (url) => {
        const query = url.searchParams.get("q") ?? "";
        expect(query).toMatch(
          /^org:example is:(issue|pull-request) (created|closed|merged|updated):/,
        );
        return query.includes(` is:${type} ${qualifier}:`)
          ? (pages.shift()?.(url) ?? searchResult([]))
          : searchResult(query.includes(" is:pull-request ") ? [merged] : []);
      },
      "/repos/example/app/pulls/2": () => json({ merged_by: { login: "reviewer" } }),
    });
    const result = await api.collect();
    expect(result.items.filter((item) => item.kind === "pr_merged")).toMatchObject([
      { actor: "reviewer", number: 2, atMs: Date.parse(at) },
    ]);
    expect(result.items.some((item) => item.kind === "pr_closed")).toBe(false);
    expect(result.status).toMatchObject({
      ok: false,
      stale: true,
      warnings: [expect.stringContaining("incomplete search results")],
    });
    const queries = requests("/search/issues").map((url) => url.searchParams.get("q") ?? "");
    expect(queries.filter((query) => query.includes(` is:${type} ${qualifier}:`))).toEqual([
      `org:example is:${type} ${qualifier}:2026-08-20T00:00:00.000Z..2026-08-20T23:59:59.000Z`,
      `org:example is:${type} ${qualifier}:2026-08-20T00:00:00.000Z..2026-08-20T11:59:59.000Z`,
      `org:example is:${type} ${qualifier}:2026-08-20T00:00:00.000Z..2026-08-20T11:59:59.000Z`,
      `org:example is:${type} ${qualifier}:2026-08-20T12:00:00.000Z..2026-08-20T23:59:59.000Z`,
    ]);
    expect(requests("/repos/example/app/pulls/2")).toHaveLength(1);
    expect(requests("/repos/example/app/pulls/3")).toHaveLength(0);
  },
);

it("collects commit-search results for eligible repositories", async () => {
  const { api } = source({
    "/orgs/example/repos": () => json([repo(), repo("other")]),
    "/search/commits": (url) => {
      expect(url.searchParams.get("q")).toContain(" committer-date:");
      return searchResult([commit()]);
    },
  });
  const result = await api.collect();
  expect(result.items).toMatchObject([
    { kind: "commit", title: "Ship the fix", repo: "example/app" },
  ]);
});

it("skips excluded and archived search results, isolates repo failures and keeps comment bodies", async () => {
  const { api } = source({
    "/orgs/example/repos": () => json([repo(), repo("other"), repo("old", true), repo("excluded")]),
    "/search/issues": (url) =>
      searchResult(
        url.searchParams.get("q")?.includes(" is:issue created:")
          ? [issue(), issue(1, "other"), issue(3, "old"), issue(4, "excluded")]
          : [],
      ),
    "/repos/example/app/issues/comments": () => json({ message: config.token }, {}, 403),
    "/repos/example/other/issues/comments": () =>
      json([comment(" Full body "), comment("outside", 2, new Date(untilMs).toISOString())]),
  });
  const result = await api.collect(exclusionConfig);
  expect(result.status.ok).toBe(false);
  expect(result.status.warnings).toEqual([expect.stringContaining("example/app")]);
  expect(JSON.stringify(result.status)).not.toContain(config.token);
  expect(result.items.map((item) => item.repo)).not.toContain("example/old");
  expect(result.items.map((item) => item.repo)).not.toContain("example/excluded");
  expect(result.items.filter((item) => item.kind === "issue_opened")).toHaveLength(2);
  expect(result.items.filter((item) => item.kind === "issue_comment")).toMatchObject([
    { body: " Full body ", actor: "reviewer" },
  ]);
});

it.each(["pull-request", "issue"])(
  "discovers comment-only repositories via updated %s searches",
  async (type) => {
    const { api, fetchImpl } = source({
      "/orgs/example/repos": () =>
        json([{ ...repo(), pushed_at: old }, repo("archived", true), repo("excluded")]),
      "/search/issues": (url) => {
        const query = url.searchParams.get("q") ?? "";
        const range = /updated:(\S+)\.\.(\S+)/.exec(query);
        // A later edit must not hide historical comments; the issue row checks this range.
        const reachesLaterUpdate =
          type !== "issue" || (range !== null && Date.parse(range[2] ?? "") > untilMs);
        return searchResult(
          query.includes(` is:${type} updated:`) && reachesLaterUpdate
            ? ["app", "archived", "excluded"].map((name) =>
                Object.assign(issue(1, name), { created_at: old }),
              )
            : [],
        );
      },
      [`/repos/example/app/${type === "issue" ? "issues" : "pulls"}/comments`]: () =>
        json([comment("New discussion on an old item")]),
    });
    const result = await api.collect(exclusionConfig);
    expect(result.items.map(({ kind, repo: name, actor }) => [kind, name, actor])).toEqual([
      [type === "issue" ? "issue_comment" : "review_comment", "example/app", "reviewer"],
    ]);
    const paths = fetchImpl.mock.calls.map(([input]) => new URL(input).pathname);
    expect(paths.filter((path) => path.endsWith("/comments"))).toEqual([
      "/repos/example/app/issues/comments",
      "/repos/example/app/pulls/comments",
    ]);
    expect(paths.some((path) => path.endsWith("/commits"))).toBe(false);
    expect(paths.some((path) => /\/pulls\/\d+$/.test(path))).toBe(false);
  },
);

it("collects advisory-only eligible repositories and stops at pre-window updates", async () => {
  const { api, fetchImpl, requests } = source({
    "/orgs/example/repos": () =>
      json([{ ...repo(), pushed_at: old }, repo("archived", true), repo("excluded")]),
    "/repos/example/app/security-advisories": (url) =>
      url.searchParams.has("page")
        ? json([])
        : page(
            [advisory, { ...advisory, published_at: old, updated_at: "2026-08-19T23:59:59Z" }],
            url,
          ),
  });
  const result = await api.collect(exclusionConfig);
  expect(
    result.items.map(({ kind, repo: name, actor, atMs }) => [kind, name, actor, atMs]),
  ).toEqual(
    ["helper", "reviewer"].map((actor) => [
      "security_advisory",
      "example/app",
      actor,
      Date.parse(at),
    ]),
  );
  expect(
    fetchImpl.mock.calls
      .map(([input]) => new URL(input).pathname)
      .filter((path) => path.startsWith("/repos/")),
  ).toEqual(["/repos/example/app/security-advisories"]);
  const urls = requests("/repos/example/app/security-advisories");
  expect(urls[0]?.searchParams.get("sort")).toBe("updated");
  expect(urls[0]?.searchParams.get("direction")).toBe("desc");
});

it("bounds comment titles while preserving full comment bodies", async () => {
  const comments = [
    { body: "  First\t  line  \r\nFull body stays here", title: "First line" },
    { body: `${"🇦🇹".repeat(141)}\nMore details`, title: `${"🇦🇹".repeat(139)}…` },
    { body: "e\u0301".repeat(140), title: "e\u0301".repeat(140) },
    { body: `${"e\u0301".repeat(141)}\nMore details`, title: `${"e\u0301".repeat(139)}…` },
    { body: " \t\nLater line", title: "Comment" },
    { body: null, title: "Comment" },
  ];
  const { api } = source({
    "/repos/example/app/issues/comments": () =>
      json(comments.map(({ body }, index) => comment(body, index))),
  });
  const result = await api.collect();
  expect(result.items.map(({ kind, title, body, url }) => [kind, title, body, url])).toEqual(
    comments.map(({ body, title }, index) => [
      "issue_comment",
      title,
      body ?? "",
      `https://github.test/comment/${index}`,
    ]),
  );
});

it.each([
  [
    [
      { login: "ignored", user: { login: "reviewer" } },
      { login: "builder", user: null },
      { login: "reviewer" },
    ],
    ["helper", "reviewer", "builder"],
  ],
  [null, ["helper"]],
  [[{ login: null, type: "reporter" }], ["helper"]],
  [undefined, ["helper"]],
] as const)("attributes advisory credits %j without stale warnings", async (credits, actors) => {
  const { api } = source({
    "/repos/example/app/security-advisories": () => json([{ ...advisory, credits }]),
  });
  const result = await api.collect();
  expect(result.status.stale).not.toBe(true);
  expect(result.items.map(({ kind, actor }) => [kind, actor])).toEqual(
    actors.map((actor) => ["security_advisory", actor]),
  );
});

it.each([403, 404, 401, 500])(
  "handles advisory HTTP %s without leaking credentials",
  async (httpStatus) => {
    vi.useFakeTimers();
    const skipped = httpStatus === 403 || httpStatus === 404;
    const { api, logs } = source({
      "/orgs/example/repos": () => json([repo(), repo("other")]),
      "/repos/example/app/security-advisories": () =>
        json({ message: config.token }, {}, httpStatus),
      "/repos/example/other/security-advisories": () => json([advisory]),
    });
    const pending = api.collect();
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result.status).toMatchObject({
      ok: skipped,
      stats: { advisoriesSkipped: skipped ? 1 : 0 },
      warnings: skipped
        ? []
        : [
            `Advisories for example/app: HTTP ${httpStatus}; check token permissions and repository access`,
          ],
    });
    if (skipped) {
      expect(result.status.stale).not.toBe(true);
      expect(logs.info).toHaveBeenCalledWith(
        expect.stringMatching(/^team-reports: .*1.*no advisories visible/),
      );
    } else {
      expect(result.status.stale).toBe(true);
    }
    expect(result.items.map(({ kind, repo: name, actor }) => [kind, name, actor])).toEqual(
      ["helper", "reviewer"].map((actor) => ["security_advisory", "example/other", actor]),
    );
    expect(JSON.stringify([result.status, logs.info.mock.calls])).not.toContain(config.token);
  },
);

it("credits event dates despite later updates and emits events within half-open windows", async () => {
  const { api } = source((url) => {
    if (url.pathname === "/search/issues" && url.searchParams.get("q")?.includes(" created:")) {
      const items = url.searchParams.get("q")?.includes(" is:pull-request ")
        ? [{ ...issue(2), pull_request: { merged_at: null }, closed_at: at }]
        : [
            {
              ...issue(),
              updated_at: issuesUpdatedAfterWindow.openedAndClosed.updated_at,
              closed_at: at,
              created_at: new Date(sinceMs).toISOString(),
            },
            { ...issue(3), created_at: new Date(untilMs).toISOString() },
          ];
      return json({
        total_count: items.length,
        items,
      });
    }
    return emptyRoute(url);
  });
  const result = await api.collect();
  expect(
    result.items
      .filter((item) => item.number !== undefined)
      .map(({ kind, number, actor }) => [kind, number, actor]),
  ).toEqual([
    ["issue_opened", 1, "builder"],
    ["issue_closed", 1, "builder"],
    ["pr_opened", 2, "builder"],
    ["pr_closed", 2, "builder"],
  ]);
});

it.each([403, 429])("waits for the rate reset on HTTP %s and records quota", async (code) => {
  vi.useFakeTimers();
  vi.setSystemTime(sinceMs);
  let calls = 0;
  const { api } = source(() => {
    calls++;
    return calls === 1
      ? json(
          {},
          {
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String((sinceMs + 2000) / 1000),
            "Retry-After": "1",
          },
          code,
        )
      : json([{ login: "builder" }], { "X-RateLimit-Remaining": "4999" });
  });
  const pending = api.loadRoster(config);
  await vi.advanceTimersByTimeAsync(1999);
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  const result = await pending;
  expect(calls).toBe(2);
  expect(result.status.stats).toMatchObject({ apiCalls: 2, rateLimitRemaining: 4999 });
});

it("never includes transport failures or server payloads in logs and status", async () => {
  const logs = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const api = bindReportFetch(createGithubSource({ logger: logs }), async () => {
    throw new Error(`transport ${config.token}`);
  });
  const result = await api.loadRoster(config);
  expect(result.status.ok).toBe(false);
  expect(result.status.warnings.length).toBeGreaterThan(0);
  expect(JSON.stringify([result, logs.warn.mock.calls, logs.error.mock.calls])).not.toContain(
    config.token,
  );
});

it("refuses cross-origin pagination before forwarding credentials", async () => {
  const { api, fetchImpl } = source(() =>
    json([{ login: "builder" }], { Link: '<https://elsewhere.test/members>; rel="next"' }),
  );
  const result = await api.loadRoster(config);
  expect(result.status.ok).toBe(false);
  expect(result.status.warnings.length).toBe(1);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

it.each(["headers", "body"] as const)(
  "reports the guarded fetch deadline while waiting for %s",
  async (stage) => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const { api } = source((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      if (stage === "headers") {
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("Timed out", "TimeoutError")),
            { once: true },
          );
        });
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            requestSignal?.addEventListener(
              "abort",
              () => controller.error(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          },
        }),
      );
    });
    const loading = api.loadRoster(config);
    await vi.advanceTimersByTimeAsync(30_000);
    const { status } = await loading;
    expect(requestSignal?.aborted).toBe(true);
    expect(status.ok).toBe(false);
    expect(status.warnings).toEqual([expect.stringContaining("API request timed out")]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

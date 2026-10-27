import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import {
  githubJson as json,
  queuedFetch as fetchResponses,
  githubRedirect as redirect,
  managedIdentity,
  requestUrl,
} from "./preview.test-support.js";
import type { GitHubTarget } from "./targets.js";
import { parseGitHubTarget } from "./targets.js";

const date = "2026-09-13T12:00:00Z";
const sha = "abcdef0123456789abcdef0123456789abcdef01";
const publicRepo = { id: 123, private: false, visibility: "public" };
let sequence = 0;

function target(kind: "issue" | "pull" | "commit" = "issue", commitSha = sha): GitHubTarget {
  const repo = "detail-" + ++sequence;
  return kind === "commit"
    ? { kind, owner: "octocat", repo, sha: commitSha }
    : { kind, owner: "octocat", repo, number: 1 };
}
function item(overrides: Record<string, unknown> = {}) {
  return {
    title: "Read me",
    body: "# Markdown\n\n  indentation  ",
    user: { login: "octocat" },
    state: "open",
    created_at: date,
    updated_at: date,
    comments: 0,
    review_comments: 0,
    changed_files: 0,
    head: { sha, ref: "feature" },
    base: { sha: "b".repeat(40), ref: "main" },
    ...overrides,
  };
}
function file(overrides: Record<string, unknown> = {}) {
  return {
    filename: "src/file.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
    ...overrides,
  };
}
function commit(overrides: Record<string, unknown> = {}, commentCount = 0) {
  return {
    sha,
    author: { login: "octocat" },
    commit: {
      message: "Subject\n\nDetails",
      author: { name: "Octocat", date },
      comment_count: commentCount,
    },
    stats: { additions: 1, deletions: 1 },
    files: [file()],
    ...overrides,
  };
}
function commentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    html_url: "https://github.com/octocat/repo/pull/1#issuecomment-1",
    user: { login: "reviewer" },
    created_at: date,
    body: "  Markdown  ",
    ...overrides,
  };
}
function publicFetch(payload: unknown, ...pages: Response[]) {
  const checks = authenticatedFetch();
  return fetchResponses(json(publicRepo), json(payload), ...pages).mockImplementation(
    async (url, options) => {
      const href = requestUrl(url);
      if (!/\/(?:check-runs\?filter=latest&per_page=100|status\?per_page=100)$/u.test(href)) {
        throw new Error("Unexpected request " + href);
      }
      return checks(url, options);
    },
  );
}

const copies = <T>(length: number, value: T): T[] => Array.from({ length }, () => value);

const identity = (scope = "selected"): ControlUiGitHubPreviewIdentity => managedIdentity(scope);
const requestPath = (input: Parameters<typeof fetch>[0]) => new URL(requestUrl(input)).pathname;
const fullPull = () => item({ comments: 1, review_comments: 1, changed_files: 1 });
const expectStatus = (pending: Promise<unknown>, statusCode: number) =>
  expect(pending).rejects.toMatchObject({ statusCode });
function paths(fetchMock: ReturnType<typeof authenticatedFetch>) {
  return fetchMock.mock.calls.map(([url]) => requestPath(url));
}
function fixture(
  kind: "issue" | "pull" | "commit" = "issue",
  payload: unknown = item(),
  intercept?: Parameters<typeof authenticatedFetch>[1],
  selected = identity(),
) {
  const input = target(kind);
  const fetchMock = authenticatedFetch(payload, intercept);
  const read = (
    section?: Parameters<typeof loadGitHubDetail>[4],
    refresh = false,
    caller: ControlUiGitHubPreviewIdentity | undefined = selected,
    transport: typeof fetch = fetchMock,
  ) => loadGitHubDetail(input, caller, transport, refresh, section);
  return { input, selected, fetchMock, read };
}

function readPublic(kind: "issue" | "pull" | "commit", payload: unknown, ...pages: Response[]) {
  return loadGitHubDetail(target(kind), undefined, publicFetch(payload, ...pages));
}

function authenticatedFetch(
  payload: unknown = item(),
  intercept?: (
    path: string,
    options?: RequestInit,
  ) => Response | undefined | Promise<Response | undefined>,
) {
  const pages: Record<string, unknown> = {
    "check-runs": { total_count: 0, check_runs: [] },
    status: { sha, total_count: 0, state: "pending", statuses: [] },
    comments: [commentItem({ diff_hunk: "@@ -1 +1 @@\n-old\n+new" })],
    files: [file()],
  };
  return vi.fn<typeof fetch>(async (url, options) => {
    const path = requestPath(url);
    const response = await intercept?.(path, options);
    if (response) {
      return response;
    }
    return json(
      /^\/repos\/[^/]+\/[^/]+$/u.test(path)
        ? publicRepo
        : (pages[path.split("/").at(-1) ?? ""] ?? payload),
    );
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it.each([401, 403, 429])("falls back after optional HTTP %s", async (status) => {
  for (const cached of [false, true]) {
    const selected = { ...identity(), optionalAuth: true as const };
    let unavailable = !cached;
    const { input, fetchMock, read } = fixture(
      "issue",
      item(),
      (_, options) =>
        unavailable && new Headers(options?.headers).has("Authorization")
          ? json({}, status)
          : undefined,
      selected,
    );
    if (cached) {
      await read();
      unavailable = true;
    }
    expect((await read()).title).toBe("Read me");
    const anonymous = fetchMock.mock.calls.filter(
      ([, options]) => !new Headers(options?.headers).has("Authorization"),
    );
    expect(anonymous.map(([url]) => requestPath(url))).toEqual([
      `/repos/${input.owner}/${input.repo}`,
      `/repos/${input.owner}/${input.repo}/issues/1`,
    ]);
  }
});

it.each([
  { name: "private", repository: { id: 123, private: true, visibility: "private" } },
  { name: "internal", repository: { id: 123, private: false, visibility: "internal" } },
  { name: "missing-visibility", repository: { id: 123, private: false } },
  { name: "replacement", repository: { id: 456, private: false, visibility: "public" } },
])("blocks fresh and cached $name data", async ({ repository }) => {
  for (const cached of [false, true]) {
    let changed = false;
    const { read } = fixture("issue", item(), (path) => {
      if (/^\/repos\/[^/]+\/[^/]+$/u.test(path)) {
        return changed ? json(repository) : undefined;
      }
      if (!cached) {
        changed = true;
      }
      return undefined;
    });
    if (cached) {
      await read();
      changed = true;
    }
    await expectStatus(read(), 404);
  }
});

it.each(["item", "review", "files"] as const)("blocks cross-repo %s redirects", async (stage) => {
  const suffix = "/pulls/1" + (stage === "item" ? "" : stage === "review" ? "/comments" : "/files");
  const { read, fetchMock } = fixture("pull", fullPull(), (pathname) => {
    if (pathname === "/repos/octocat/another") {
      return json({ id: 456, private: false, visibility: "public" });
    }
    if (pathname.endsWith(suffix)) {
      return redirect("/repos/octocat/another" + suffix);
    }
    return undefined;
  });
  await expectStatus(read(), 404);
  expect(paths(fetchMock).some((path) => path.includes("/another/"))).toBe(false);
});

it("follows renames with the same repository ID", async () => {
  const { input, read, fetchMock } = fixture("issue", item(), (pathname) => {
    if (pathname === "/repos/octocat/" + input.repo + "/issues/1") {
      return redirect("/repositories/123/issues/1");
    }
    return pathname === "/repositories/123" ? json(publicRepo) : undefined;
  });
  expect((await read()).title).toBe("Read me");
  expect(paths(fetchMock)).toContain("/repositories/123/issues/1");
});

it("isolates credential scopes and rotations", async () => {
  const first = identity("first");
  const { read } = fixture("issue", item(), (path, options) => {
    if (path.endsWith("/issues/1")) {
      return json(item({ title: new Headers(options?.headers).get("Authorization") }));
    }
    return undefined;
  });
  for (const selected of [first, identity("second"), { ...first, token: "rotated-token" }]) {
    const result = await read(undefined, false, selected);
    expect(result.title).toBe("Bearer " + selected.token);
    expect(await read(undefined, false, selected)).toBe(result);
  }
});

it("isolates concurrent readers when one identity is revoked", async () => {
  const pending = createDeferred<Response>();
  const started = createDeferred<void>();
  let waiting = true;
  const { selected, read } = fixture("issue", item(), () => {
    if (waiting) {
      waiting = false;
      started.resolve();
      return pending.promise;
    }
    return undefined;
  });
  const revoke = () => {
    selected.assertSelected = () => {
      throw new Error("identity changed");
    };
  };
  const first = read();
  await started.promise;
  expect((await read(undefined, false, identity())).title).toBe("Read me");
  revoke();
  pending.resolve(json(publicRepo));
  await expect(first).rejects.toThrow("identity changed");
  await expect(read(undefined, false, identity())).resolves.toMatchObject({
    title: "Read me",
    partial: false,
  });
});
describe("GitHub detail public read boundary", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "test-ambient-token");
    vi.stubEnv("GITHUB_TOKEN", "test-other-ambient-token");
  });

  it.each([
    [false, 404],
    [true, 404],
    [true, 401],
  ] as const)("stops denied reads before items (selected=%s, HTTP %s)", async (selected, code) => {
    const denied = code === 401 ? json({}, 401) : json({ ...publicRepo, private: true });
    const fetchMock = fetchResponses(denied);
    await expectStatus(
      loadGitHubDetail(target(), selected ? identity() : undefined, fetchMock),
      code,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    if (selected) {
      expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty("Authorization");
    }
  });

  it.each([
    "https://example.com/private",
    "http://api.github.com/repos/octocat/repo",
    "https://user:password@api.github.com/repos/octocat/repo",
  ])("rejects redirect %s without following it", async (location) => {
    const response = new Response("discard", { status: 301, headers: { Location: location } });
    const fetchMock = fetchResponses(json(publicRepo), response);
    await expectStatus(loadGitHubDetail(target(), undefined, fetchMock), 502);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.bodyUsed).toBe(true);
  });

  it("caps redirect chains", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => redirect("/repositories/123"));
    await expectStatus(loadGitHubDetail(target(), undefined, fetchMock), 502);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("expires cached visibility failures", async () => {
    const input = target();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const fetchMock = fetchResponses(json({}, 404), json(publicRepo), json(item()));
    await expectStatus(loadGitHubDetail(input, undefined, fetchMock), 404);
    await expectStatus(loadGitHubDetail(input, undefined, fetchMock), 404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    now.mockReturnValue(32_000);
    expect((await loadGitHubDetail(input, undefined, fetchMock)).partial).toBe(false);
  });

  it("bounds UTF-16 content, pages and patch totals", async () => {
    const comment = commentItem({ body: "x".repeat(5000) });
    const bodyPrefix = "b".repeat(32 * 1024 - 1);
    const patchPrefix = "p".repeat(16 * 1024 - 1);
    const fetchMock = publicFetch(
      item({ body: bodyPrefix + "😀tail", comments: 25, review_comments: 25, changed_files: 35 }),
      json(copies(25, comment), 200, { Link: '<https://api.github.com/ignored>; rel="next"' }),
      json(copies(25, commentItem({ body: comment.body, diff_hunk: "h".repeat(5000) }))),
      json(copies(35, file({ patch: patchPrefix + "😀tail" }))),
    );
    const detail = await loadGitHubDetail(target("pull"), undefined, fetchMock);
    expect(detail).toMatchObject({
      bodyTruncated: true,
      commentsTruncated: true,
      filesTruncated: true,
      partial: true,
      commentsTotal: 50,
      filesTotal: 35,
    });
    expect(detail.body).toBe(bodyPrefix);
    expect(detail.files[0]?.patch).toBe(patchPrefix);
    const reviews = detail.comments.filter((entry) => entry.label === "Review comment");
    expect(reviews).toMatchObject(
      copies(20, { context: { diff: "h".repeat(4096), diffTruncated: true } }),
    );
    expect(detail.comments).toMatchObject(
      copies(40, { body: "x".repeat(4096), bodyTruncated: true }),
    );
    expect(detail.files).toHaveLength(30);
    expect(detail.files.reduce((sum, entry) => sum + (entry.patch?.length ?? 0), 0)).toBe(
      96 * 1024,
    );
    expect(
      detail.files.every(
        (entry) => entry.patchTruncated && (entry.patch?.length ?? 0) <= 16 * 1024,
      ),
    ).toBe(true);
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("renders sorted discussion, review context and renames", async () => {
    const discussion = commentItem({ id: 3, created_at: "2026-09-13T12:01:00Z", user: null });
    const diffHunk = "@@ -12,3 +12,3 @@\n-old\n+new";
    const review = commentItem({
      html_url: "https://github.com/octocat/repo/pull/1#discussion_r1",
      original_line: 14,
      original_start_line: 12,
      side: "RIGHT",
      diff_hunk: diffHunk,
    });
    const reply = commentItem({
      id: 2,
      created_at: "2026-09-13T12:02:00Z",
      html_url: "https://github.com/octocat/repo/pull/1#discussion_r2",
      in_reply_to_id: 1,
      line: 15,
      start_line: 13,
      diff_hunk: diffHunk,
    });
    const detail = await readPublic(
      "pull",
      item({ comments: 1, review_comments: 2, changed_files: 1 }),
      json([discussion]),
      json([review, reply]),
      json([file({ status: "renamed", previous_filename: "old.ts" })]),
    );
    expect(detail).toMatchObject({
      partial: false,
      body: "# Markdown\n\n  indentation  ",
      commentsTotal: 3,
      files: [{ previousPath: "old.ts", patch: file().patch, patchTruncated: false }],
    });
    expect(detail.comments).toMatchObject([
      { id: "discussion_r1", context: { lineLabel: "12–14", label: "After change · Outdated" } },
      { id: "issuecomment-1", author: "ghost" },
      {
        id: "discussion_r2",
        context: { lineLabel: "13–15", replyLabel: "In reply to #1", replyUrl: review.html_url },
      },
    ]);
    expect(detail.comments[1]?.context).toBeUndefined();
  });

  it.each([false, true])("renders anonymous commit content (binary=%s)", async (binary) => {
    const comment = commentItem({
      path: binary ? null : "src/file.ts",
      line: binary ? null : 14,
      html_url: `https://github.com/octocat/repo/commit/${sha}#commitcomment-1`,
    });
    const payload = binary
      ? commit({
          author: null,
          commit: { author: null, message: "", comment_count: 1 },
          files: [file({ patch: undefined })],
        })
      : commit({}, 1);
    const fetchMock = fetchResponses(
      json(publicRepo),
      json(payload, 200, binary ? { Link: '<https://api.github.com/ignored>; rel="next"' } : {}),
      json([comment]),
    );
    const detail = await loadGitHubDetail(
      target("commit", sha.slice(0, 7).toUpperCase()),
      undefined,
      fetchMock,
    );
    expect(detail).toMatchObject({
      partial: binary,
      body: binary ? "" : "Subject\n\nDetails",
      commentsTotal: 1,
      filesTruncated: binary,
      files: [{ patchTruncated: binary }],
      author: binary ? "ghost" : "octocat",
      createdAt: binary ? undefined : date,
      comments: [
        {
          url: comment.html_url,
          context: {
            path: binary ? undefined : "src/file.ts",
            lineLabel: binary ? undefined : "14",
          },
        },
      ],
    });
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("keeps the item after files fail", async () => {
    const detail = await readPublic("pull", item({ changed_files: 1 }), json({}, 429));
    expect(detail).toMatchObject({
      title: "Read me",
      partial: true,
      filesTruncated: true,
      files: [],
    });
  });

  it.each(["https://example.com/steal", "https://user:secret@github.com/owner/repo"])(
    "omits unsafe permalink %s",
    async (html_url) => {
      const detail = await readPublic("commit", commit({}, 1), json([commentItem({ html_url })]));
      expect(detail).toMatchObject({
        title: "Subject",
        partial: true,
        commentsTruncated: true,
        commentsTotal: 1,
      });
      expect(detail.comments).toHaveLength(0);
    },
  );

  it.each([false, true])("bounds response bytes (declared=%s)", async (declaredLength) => {
    const response = new Response("x".repeat(1024 * 1024 + 1), {
      headers: declaredLength ? { "Content-Length": String(1024 * 1024 + 1) } : {},
    });
    const fetchMock = fetchResponses(json(publicRepo), response);
    await expect(loadGitHubDetail(target(), undefined, fetchMock)).rejects.toThrow();
    expect(response.bodyUsed).toBe(true);
  });
});

it("overlaps comment reads even when discussion fails", async () => {
  vi.useFakeTimers();
  try {
    const { read } = fixture("pull", fullPull(), async (path) => {
      if (!path.endsWith("/comments")) {
        return undefined;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
      return path.includes("/issues/")
        ? json([commentItem()], 503)
        : json([
            commentItem({
              id: 2,
              html_url: "https://github.com/octocat/repo/pull/1#discussion_r2",
            }),
          ]);
    });
    const started = Date.now();
    const pending = read("discussion");
    await vi.runAllTimersAsync();
    const document = await pending;
    expect(document).toMatchObject({ title: "Read me", partial: true });
    expect(Date.now() - started).toBe(100);
    expect(document.comments?.map((comment) => comment.id)).toEqual(["discussion_r2"]);
    expect(document.commentsTotal).toBe(2);
    expect(document.commentsTruncated).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

it("loads independent sections and retires old heads", async () => {
  const checks = createDeferred<Response>();
  const checksStarted = createDeferred<void>();
  let delayChecks = true;
  let currentSha = sha;
  const { read, fetchMock } = fixture("pull", fullPull(), (path) => {
    if (delayChecks && path.endsWith("/check-runs")) {
      delayChecks = false;
      checksStarted.resolve();
      return checks.promise;
    }
    if (path.endsWith("/pulls/1")) {
      return json({ ...fullPull(), head: { sha: currentSha } });
    }
    if (path.endsWith("/status")) {
      return json({ sha: currentSha, total_count: 0, statuses: [] });
    }
    return undefined;
  });
  const overview = await read("overview");
  expect(overview).toMatchObject({
    revision: sha,
    deferredSections: ["checks", "files", "discussion"],
  });
  expect(overview.checks).toBeUndefined();
  expect(overview.comments).toBeUndefined();
  expect(overview.files).toBeUndefined();
  expect(
    paths(fetchMock).every((path) => !/\/(?:comments|files|check-runs|status)$/u.test(path)),
  ).toBe(true);

  const pendingChecks = read("checks");
  await checksStarted.promise;
  try {
    const discussion = await read("discussion", false, identity());
    expect(discussion).toMatchObject({ revision: sha, partial: false });
    expect(discussion.comments).toHaveLength(2);
    expect(discussion.checks).toBeUndefined();
    expect(discussion.files).toBeUndefined();
    expect(paths(fetchMock).some((path) => path.endsWith("/files"))).toBe(false);
    const files = await read("files");
    expect(files).toMatchObject({
      revision: sha,
      files: [{ path: "src/file.ts", patch: file().patch }],
    });
    expect(files.comments).toBeUndefined();
    expect(files.checks).toBeUndefined();
  } finally {
    checks.resolve(json({ total_count: 0, check_runs: [] }));
  }
  expect(await pendingChecks).toMatchObject({
    revision: sha,
    checks: { commit: sha, state: "neutral" },
  });
  // Omitting section still returns the shipped full document, not the overview cache.
  const complete = await read();
  expect(complete).toMatchObject({ partial: false, checks: { commit: sha, state: "neutral" } });
  expect(complete.comments).toHaveLength(2);
  expect(complete.files).toHaveLength(1);
  expect(complete.deferredSections).toBeUndefined();
  currentSha = "d".repeat(40);
  expect((await read("overview", true)).revision).toBe(currentSha);
  expect(await read("checks")).toMatchObject({
    revision: currentSha,
    checks: { commit: currentSha, state: "neutral" },
  });
});

it("rejects files when the PR head moves", async () => {
  let filesRead = false;
  const { read } = fixture("pull", item({ changed_files: 1 }), (path) => {
    if (filesRead && path.endsWith("/pulls/1")) {
      return json(item({ changed_files: 1, head: { sha: "d".repeat(40) } }));
    }
    filesRead ||= path.endsWith("/files");
    return undefined;
  });
  await expectStatus(read("files"), 409);
});

it("rechecks settled overview authority", async () => {
  const { selected, read } = fixture("pull");
  await read("overview");
  selected.assertSelected = () => {
    throw new Error("Reader retired");
  };
  const blocked = vi.fn<typeof fetch>();
  await expect(read("checks", false, selected, blocked)).rejects.toThrow("Reader retired");
  expect(blocked).not.toHaveBeenCalled();
  const privateRepo = vi.fn<typeof fetch>(async () =>
    json({ id: 123, private: true, visibility: "private" }),
  );
  await expectStatus(read("discussion", false, identity(), privateRepo), 404);
  expect(privateRepo).toHaveBeenCalledTimes(1);
  // A completed source never retains the first caller's assertions.
  await expect(read("checks", false, identity())).resolves.toMatchObject({
    revision: sha,
    checks: { state: "neutral" },
  });
});

it.each(["issue", "commit"] as const)("binds deferred %s revisions", async (kind) => {
  const { selected, read, fetchMock } = fixture(kind, kind === "commit" ? commit() : item());
  const overview = await read("overview");
  expect(overview.revision).toBe(kind === "commit" ? sha : date);
  expect(overview.deferredSections).toEqual(
    kind === "commit" ? ["files", "discussion"] : ["discussion"],
  );
  expect(overview.files).toBeUndefined();
  expect(overview.comments).toBeUndefined();
  const updatedAt = "2026-10-17T00:00:00Z";
  const transport =
    kind === "commit" ? fetchMock : authenticatedFetch(item({ updated_at: updatedAt }));
  expect(await read("discussion", false, selected, transport)).toMatchObject({
    revision: kind === "commit" ? sha : updatedAt,
    comments: [],
    commentsTotal: 0,
  });
});
const baseTarget = { kind: "issue", owner: "octocat", repo: "repo", number: 1 };
it.each([
  null,
  { ...baseTarget, kind: "comment" },
  { ...baseTarget, repo: ".." },
  { ...baseTarget, repo: "repo.git" },
  { ...baseTarget, repo: "repo.atom" },
  { ...baseTarget, number: 1.5 },
  { ...baseTarget, agentId: " " },
  { kind: "commit", owner: "octocat", repo: "repo", sha: "abcdef0/../../secrets" },
  { kind: "commit", owner: "octocat", repo: "repo", sha, number: 1 },
  { kind: "issue", owner: "octocat", repo: "repo", sha, number: 1 },
])("rejects malformed target %#", (value) => {
  expect(parseGitHubTarget(value)).toBeNull();
});

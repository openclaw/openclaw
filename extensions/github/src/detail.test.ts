import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import type { GitHubTarget } from "./targets.js";
import { parseGitHubTarget } from "./targets.js";

const date = "2026-09-13T12:00:00Z";
const sha = "abcdef0123456789abcdef0123456789abcdef01";
let sequence = 0;
function target(kind: "issue" | "pull" | "commit" = "issue"): GitHubTarget {
  const repo = "detail-" + ++sequence;
  return kind === "commit"
    ? { kind, owner: "octocat", repo, sha }
    : { kind, owner: "octocat", repo, number: 1 };
}
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
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
function commit(overrides: Record<string, unknown> = {}) {
  return {
    sha,
    author: { login: "octocat" },
    commit: { message: "Subject\n\nDetails", author: { name: "Octocat", date }, comment_count: 0 },
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
    updated_at: date,
    body: "  Markdown  ",
    ...overrides,
  };
}
function publicFetch(payload: unknown) {
  return vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(json({ private: false }))
    .mockResolvedValueOnce(json(payload));
}

describe("GitHub detail public read boundary", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "test-ambient-token");
    vi.stubEnv("GITHUB_TOKEN", "test-other-ambient-token");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["issue", "pull", "commit"] as const)(
    "returns %s content without ambient credentials and coalesces reads",
    async (kind) => {
      const input = target(kind);
      const fetchMock = publicFetch(kind === "commit" ? commit() : item());
      const [first, second] = await Promise.all([
        loadGitHubDetail(input, fetchMock),
        loadGitHubDetail(input, fetchMock),
      ]);
      expect(first).toBe(second);
      expect(first).toMatchObject({
        author: "octocat",
        createdAt: date,
        partial: false,
        bodyTruncated: false,
      });
      expect(first.body).toBe(kind === "commit" ? "Subject\n\nDetails" : item().body);
      expect(first.url).toBe(
        "https://github.com/octocat/" +
          input.repo +
          "/" +
          (kind === "issue" ? "issues" : kind) +
          "/" +
          (kind === "commit" ? sha : "1"),
      );
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const [url, options] of fetchMock.mock.calls) {
        expect(url).toMatch(/^https:\/\/api\.github\.com\/repos\/octocat\//u);
        expect(options?.headers).not.toHaveProperty("Authorization");
        expect(options?.redirect).toBe("manual");
      }
    },
  );

  it("refreshes an explicitly requested item instead of returning the cached document", async () => {
    const input = target();
    const fetchMock = publicFetch(item())
      .mockResolvedValueOnce(json({ private: false }))
      .mockResolvedValueOnce(json(item({ title: "Updated title" })));
    await loadGitHubDetail(input, fetchMock);
    await expect(loadGitHubDetail(input, fetchMock, true)).resolves.toMatchObject({
      title: "Updated title",
    });
    await expect(loadGitHubDetail(input, fetchMock)).resolves.toMatchObject({
      title: "Updated title",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: "private", body: { private: true }, status: 200 },
    { name: "missing", body: { message: "Not Found" }, status: 404 },
    { name: "unknown visibility", body: {}, status: 200 },
  ])("stops $name before fetching the object", async ({ body, status }) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(body, status));
    await expect(loadGitHubDetail(target(), fetchMock)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://example.com/private",
    "http://api.github.com/repos/octocat/repo",
    "https://user:password@api.github.com/repos/octocat/repo",
  ])("rejects redirect %s without following it", async (location) => {
    const redirect = new Response("discard", { status: 301, headers: { Location: location } });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ private: false }))
      .mockResolvedValueOnce(redirect);
    await expect(loadGitHubDetail(target(), fetchMock)).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(redirect.bodyUsed).toBe(true);
  });

  it("follows bounded same-origin renames but never forwards a token after a visibility change", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ private: false }))
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { Location: "/repositories/123/issues/1" } }),
      )
      .mockResolvedValueOnce(json({ message: "Not Found" }, 404));
    await expect(loadGitHubDetail(target(), fetchMock)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(fetchMock.mock.calls[2]?.[0]).toBe("https://api.github.com/repositories/123/issues/1");
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("caps redirect chains", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () => new Response(null, { status: 301, headers: { Location: "/repositories/123" } }),
      );
    await expect(loadGitHubDetail(target(), fetchMock)).rejects.toMatchObject({
      statusCode: 502,
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  const failures: Array<{ status: number; headers: Record<string, string>; expected: number }> = [
    { status: 429, headers: {}, expected: 429 },
    { status: 403, headers: { "x-ratelimit-remaining": "0" }, expected: 429 },
    { status: 403, headers: { "retry-after": "60" }, expected: 429 },
    { status: 403, headers: {}, expected: 403 },
    { status: 503, headers: {}, expected: 502 },
  ];
  it.each(failures)(
    "normalizes $status/$expected failures and caches repeated opens",
    async ({ status, headers, expected }) => {
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ message: "upstream" }, status, headers));
      const input = target();
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(loadGitHubDetail(input, fetchMock)).rejects.toMatchObject({
          statusCode: expected,
        });
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it("expires cached visibility failures rather than making a missing repository permanently unavailable", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const input = target();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(json({ private: false }))
      .mockResolvedValueOnce(json(item()));
    await expect(loadGitHubDetail(input, fetchMock)).rejects.toMatchObject({
      statusCode: 404,
    });
    now.mockReturnValue(32_000);
    await expect(loadGitHubDetail(input, fetchMock)).resolves.toMatchObject({
      partial: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("bounds discussion, review context, and file patches with explicit partial flags", async () => {
    const comment = commentItem({ body: "x".repeat(5000) });
    const fetchMock = publicFetch(
      item({ body: "b".repeat(40_000), comments: 25, review_comments: 25, changed_files: 35 }),
    )
      .mockResolvedValueOnce(
        json(
          Array.from({ length: 25 }, () => comment),
          200,
          { Link: '<https://api.github.com/ignored>; rel="next"' },
        ),
      )
      .mockResolvedValueOnce(
        json(
          Array.from({ length: 25 }, () =>
            commentItem({
              body: comment.body,
              path: "src/file.ts",
              diff_hunk: "h".repeat(5000),
            }),
          ),
        ),
      )
      .mockResolvedValueOnce(
        json(Array.from({ length: 35 }, () => file({ patch: "p".repeat(20_000) }))),
      );
    const detail = await loadGitHubDetail(target("pull"), fetchMock);
    expect(detail).toMatchObject({
      bodyTruncated: true,
      commentsTruncated: true,
      filesTruncated: true,
      partial: true,
      commentsTotal: 50,
      filesTotal: 35,
    });
    expect(detail.body).toHaveLength(32 * 1024);
    expect(detail.comments).toHaveLength(40);
    const reviews = detail.comments.filter((entry) => entry.label === "Review comment");
    expect(reviews).toHaveLength(20);
    expect(
      reviews.every((entry) => entry.context?.diff?.length === 4096 && entry.context.diffTruncated),
    ).toBe(true);
    expect(
      detail.comments.every((entry) => entry.body.length === 4096 && entry.bodyTruncated),
    ).toBe(true);
    expect(detail.files).toHaveLength(30);
    expect(detail.files.reduce((sum, entry) => sum + (entry.patch?.length ?? 0), 0)).toBe(
      96 * 1024,
    );
    expect(
      detail.files.every(
        (entry) => entry.patchTruncated && (entry.patch?.length ?? 0) <= 16 * 1024,
      ),
    ).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/issues/1/comments?per_page=20");
    expect(fetchMock.mock.calls[3]?.[0]).toContain(
      "/pulls/1/comments?per_page=20&sort=created&direction=asc",
    );
    expect(fetchMock.mock.calls[4]?.[0]).toContain("/pulls/1/files?per_page=30");
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it("preserves complete nonempty comments and renamed file patches", async () => {
    const comment = commentItem({ user: null, body: "  Markdown  " });
    const fetchMock = publicFetch(item({ comments: 1, changed_files: 1 }))
      .mockResolvedValueOnce(json([comment]))
      .mockResolvedValueOnce(json([file({ status: "renamed", previous_filename: "old.ts" })]));
    const detail = await loadGitHubDetail(target("pull"), fetchMock);
    expect(detail).toMatchObject({
      partial: false,
      comments: [{ author: "ghost", body: comment.body, bodyTruncated: false }],
      files: [{ previousPath: "old.ts", patch: file().patch, patchTruncated: false }],
    });
  });

  it("merges discussion and review replies chronologically with exact diff and original-line context", async () => {
    const discussion = commentItem({ id: 3, created_at: "2026-09-13T12:01:00Z" });
    const diffHunk = "@@ -12,3 +12,3 @@\n-old\n+new";
    const review = commentItem({
      html_url: "https://github.com/octocat/repo/pull/1#discussion_r1",
      path: "src/file.ts",
      line: null,
      original_line: 14,
      start_line: null,
      original_start_line: 12,
      side: "RIGHT",
      start_side: "LEFT",
      diff_hunk: diffHunk,
    });
    const reply = commentItem({
      id: 2,
      created_at: "2026-09-13T12:02:00Z",
      html_url: "https://github.com/octocat/repo/pull/1#discussion_r2",
      in_reply_to_id: 1,
      path: "src/file.ts",
      line: 15,
      start_line: 13,
      diff_hunk: diffHunk,
    });
    const fetchMock = publicFetch(item({ comments: 1, review_comments: 2 }))
      .mockResolvedValueOnce(json([discussion]))
      .mockResolvedValueOnce(json([review, reply]));
    const detail = await loadGitHubDetail(target("pull"), fetchMock);
    expect(detail).toMatchObject({
      partial: false,
      commentsTotal: 3,
      commentsTruncated: false,
      comments: [
        {
          id: "discussion_r1",
          label: "Review comment",
          url: review.html_url,
          context: {
            path: "src/file.ts",
            lineLabel: "12–14",
            label: "After change · Outdated",
            diff: diffHunk,
            diffTruncated: false,
          },
        },
        { id: "issuecomment-1", url: discussion.html_url, body: discussion.body },
        {
          id: "discussion_r2",
          label: "Review comment",
          context: { lineLabel: "13–15", replyLabel: "In reply to #1", replyUrl: review.html_url },
        },
      ],
    });
    expect(detail.comments[1]?.context).toBeUndefined();
  });

  it("loads commit comments with source permalinks and optional file locations anonymously", async () => {
    const first = commentItem({
      html_url: "https://github.com/octocat/repo/commit/" + sha + "#commitcomment-1",
      path: "src/file.ts",
      line: 14,
    });
    const second = commentItem({
      id: 2,
      html_url: "https://github.com/octocat/repo/commit/" + sha + "#commitcomment-2",
      path: null,
      line: null,
    });
    const fetchMock = publicFetch(
      commit({ commit: { ...commit().commit, comment_count: 2 } }),
    ).mockResolvedValueOnce(json([first, second]));
    const detail = await loadGitHubDetail(target("commit"), fetchMock);
    expect(detail).toMatchObject({
      partial: false,
      commentsTotal: 2,
      commentsTruncated: false,
      comments: [
        {
          url: first.html_url,
          context: { path: "src/file.ts", lineLabel: "14" },
          body: first.body,
        },
        { url: second.html_url },
      ],
    });
    expect(detail.comments[1]?.context?.lineLabel).toBeUndefined();
    expect(detail.comments[1]?.context?.path).toBeUndefined();
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/commits/" + sha + "/comments?per_page=20");
    for (const [, options] of fetchMock.mock.calls) {
      expect(options?.headers).not.toHaveProperty("Authorization");
    }
  });

  it.each(["comments", "review", "files"] as const)(
    "keeps the item visible when %s cannot load",
    async (section) => {
      const fetchMock = publicFetch(
        item({
          comments: section === "comments" ? 1 : 0,
          review_comments: section === "review" ? 1 : 0,
          changed_files: section === "files" ? 1 : 0,
        }),
      ).mockResolvedValueOnce(json({}, 429));
      const detail = await loadGitHubDetail(target("pull"), fetchMock);
      expect(detail).toMatchObject({
        title: "Read me",
        partial: true,
        [(section === "review" ? "comments" : section) + "Truncated"]: true,
        [section === "review" ? "comments" : section]: [],
      });
    },
  );

  it.each([
    { name: "request failure", response: () => json({}, 429) },
    {
      name: "unsafe permalink",
      response: () => json([commentItem({ html_url: "https://example.com/steal" })]),
    },
    {
      name: "credential permalink",
      response: () =>
        json([commentItem({ html_url: "https://user:secret@github.com/owner/repo" })]),
    },
    {
      name: "more pages",
      response: () =>
        json([commentItem()], 200, { Link: '<https://example.com/never-follow>; rel="next"' }),
    },
  ])(
    "marks incomplete commit comments for $name without losing the commit",
    async ({ name, response }) => {
      const fetchMock = publicFetch(
        commit({ commit: { ...commit().commit, comment_count: 1 } }),
      ).mockResolvedValueOnce(response());
      const detail = await loadGitHubDetail(target("commit"), fetchMock);
      expect(detail).toMatchObject({
        title: "Subject",
        partial: true,
        commentsTruncated: true,
        commentsTotal: 1,
      });
      expect(detail.comments).toHaveLength(name === "more pages" ? 1 : 0);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("marks omitted binary patches and commit file pagination rather than claiming complete content", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ private: false }))
      .mockResolvedValueOnce(
        json(
          commit({
            author: null,
            commit: { author: null, message: "", comment_count: 0 },
            files: [file({ patch: undefined })],
          }),
          200,
          { Link: '<https://api.github.com/ignored>; rel="next"' },
        ),
      );
    const detail = await loadGitHubDetail(target("commit"), fetchMock);
    expect(detail).toMatchObject({
      badge: { label: "Commit", tone: "neutral" },
      author: "ghost",
      body: "",
      filesTruncated: true,
      partial: true,
      files: [{ patchTruncated: true }],
    });
    expect(detail.createdAt).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    "rejects oversized main responses (declared length: %s)",
    async (declaredLength) => {
      const response = new Response("x".repeat(1024 * 1024 + 1), {
        headers: declaredLength ? { "Content-Length": String(1024 * 1024 + 1) } : {},
      });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ private: false }))
        .mockResolvedValueOnce(response);
      await expect(loadGitHubDetail(target(), fetchMock)).rejects.toThrow();
      expect(response.bodyUsed).toBe(true);
    },
  );
});

describe("GitHub detail target validation", () => {
  it.each([
    null,
    [],
    {},
    { kind: "blob", owner: "octocat", repo: "repo", number: 1 },
    { kind: "issue", owner: "../octocat", repo: "repo", number: 1 },
    { kind: "issue", owner: "octocat", repo: "..", number: 1 },
    { kind: "pull", owner: "octocat", repo: "repo", number: 1.5 },
    { kind: "pull", owner: "octocat", repo: "repo", number: 0 },
    { kind: "issue", owner: "octocat", repo: "repo", number: 10_000_000_000 },
    { kind: "commit", owner: "octocat", repo: "repo", sha: "main" },
    { kind: "commit", owner: "octocat", repo: "repo", sha: "abcdef0/../../secrets" },
    { kind: "commit", owner: "octocat", repo: "repo", sha: "a".repeat(41) },
    { kind: "commit", owner: "octocat", repo: "repo", sha, number: 1 },
    { kind: "issue", owner: "octocat", repo: "repo", sha, number: 1 },
  ])("rejects malformed target %#", (value) => {
    expect(parseGitHubTarget(value)).toBeNull();
  });

  it.each(["abcdef0", sha, sha.toUpperCase()])(
    "accepts only bounded hex commit ids: %s",
    (value) => {
      expect(
        parseGitHubTarget({
          kind: "commit",
          owner: "octocat",
          repo: ".github",
          sha: value,
        }),
      ).toEqual({ kind: "commit", owner: "octocat", repo: ".github", sha: value.toLowerCase() });
    },
  );
});

import { afterEach, expect, it, vi } from "vitest";
import { loadSessionGitHubDetail } from "./detail.js";
import { loadSessionGitHubPreview, loadControlUiGitHubPreview } from "./preview.js";
import type { SessionGitHubReadIdentity } from "./session-reader.js";

const host = "ghe.example.test";
const apiBaseUrl = `https://${host}/api/v3`;
const target = { owner: "example", repo: "project", kind: "issue" as const, number: 7 };
const time = "2026-10-10T10:00:00Z";
afterEach(() => vi.restoreAllMocks());
function identity(scope: string): SessionGitHubReadIdentity {
  return {
    host,
    apiBaseUrl,
    repository: { owner: target.owner, repo: target.repo, id: 404 },
    token: "synthetic-app-token",
    cacheScope: scope,
    assertSelected() {},
    revalidate: async () => {},
  };
}
function fetchFixture() {
  return vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    expect(url.origin + "/api/v3").toBe(apiBaseUrl);
    if (url.pathname.endsWith("/repos/example/project")) {
      return Response.json({ id: 404, full_name: "example/project", private: true });
    }
    if (url.pathname.endsWith("/issues/7")) {
      return Response.json({
        title: "Private issue",
        body: "Whole private instructions",
        state: "open",
        user: { login: "reader" },
        created_at: time,
        updated_at: time,
        comments: 0,
        repository_url: `${apiBaseUrl}/repos/example/project`,
      });
    }
    throw new Error("Unexpected fixture resource");
  });
}
it("renders Enterprise documents and isolates same-token cache entries by current session/principal", async () => {
  const fetcher = fetchFixture();
  const first = identity("principal-a/session-a");
  const result = await loadSessionGitHubDetail(target, first, fetcher);
  expect(result).toMatchObject({
    title: "Private issue",
    body: "Whole private instructions",
    url: `https://${host}/example/project/issues/7`,
    authorUrl: `https://${host}/reader`,
  });
  expect((await loadSessionGitHubPreview(target, first, fetcher)).title).toBe("Private issue");
  const overview = await loadSessionGitHubDetail(target, first, fetcher, false, "overview");
  expect(overview).toMatchObject({
    title: "Private issue",
    revision: time,
    deferredSections: ["discussion"],
  });
  expect(overview.comments).toBeUndefined();
  const discussion = await loadSessionGitHubDetail(target, first, fetcher, false, "discussion");
  expect(discussion).toMatchObject({ revision: time, comments: [], commentsTotal: 0 });
  const requests = fetcher.mock.calls.length;
  await loadSessionGitHubDetail(target, identity("principal-b/session-a"), fetcher);
  expect(fetcher.mock.calls.length).toBeGreaterThan(requests);
  const next = fetcher.mock.calls.length;
  await loadSessionGitHubDetail(target, identity("principal-b/session-b"), fetcher);
  expect(fetcher.mock.calls.length).toBeGreaterThan(next);
  first.assertSelected = () => {
    throw new Error("Reader retired");
  };
  expect(() => loadSessionGitHubDetail(target, first, fetcher)).toThrow("Reader retired");
});
it.each([403, 404, 302])(
  "never substitutes anonymous metadata for private denial/redirect %s",
  async (status) => {
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status,
          headers: status === 302 ? { location: "https://foreign.example/private" } : {},
        }),
    );
    await expect(loadSessionGitHubPreview(target, identity("denied"), fetcher)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledOnce();
  },
);
it("retains public-only repository admission even when a caller supplies session identity fields", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    Response.json({ id: 404, private: true, visibility: "private" }),
  );
  await expect(
    loadControlUiGitHubPreview(target, identity("public-cannot-upgrade"), fetcher),
  ).rejects.toThrow("not public");
  expect(fetcher).toHaveBeenCalledOnce();
});

it("previews Enterprise commits through the admitted API base without loading discussion", async () => {
  const sha = "abcdef0123456789abcdef0123456789abcdef01";
  const fetchRepository = fetchFixture();
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === apiBaseUrl + "/repos/example/project/commits/" + sha + "?per_page=1") {
      return Response.json({
        sha,
        url: apiBaseUrl + "/repos/example/project/commits/" + sha,
        commit: { message: "Private commit", author: { date: time }, comment_count: 0 },
        author: { login: "reader" },
        stats: { additions: 2, deletions: 1 },
      });
    }
    return fetchRepository(input, init);
  });
  const preview = await loadSessionGitHubPreview(
    { owner: "example", repo: "project", kind: "commit", sha },
    identity("commit-session"),
    fetcher,
  );
  expect(preview).toMatchObject({
    kind: "commit",
    sha,
    title: "Private commit",
    additions: 2,
    deletions: 1,
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readSessionPullRequestMetadata } from "./control-ui-session-pr-metadata-api.js";
import { prepareSessionPullRequestGitHubRead } from "./control-ui-session-pr-request-api.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./session-prs.test-support.js";
const { load: loadControlUiSessionPullRequests } = createSessionPullRequestsFixture();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each(["list", "warm metadata", "cold metadata"])(
  "marks PR data unavailable after a %s failure, then retries after 30 seconds",
  async (failure) => {
    const sessionKey = "agent:main:stale-preview";
    vi.useFakeTimers();
    try {
      let failed = false;
      const metadata = failure !== "list";
      const number = failure === "list" ? 103469 : failure === "warm metadata" ? 103470 : 103471;
      const detailUrl = `https://api.github.com/repos/openclaw/openclaw/pulls/${number}`;
      const fetchImpl = routedFetch([
        {
          match: "/pulls?head=",
          response: () =>
            failed && !metadata
              ? githubJson({ message: "Unavailable" }, 503)
              : githubJson([
                  pullListItem({
                    number,
                    html_url: `https://github.com/openclaw/openclaw/pull/${number}`,
                    ...(metadata ? {} : { state: "closed", merged_at: "2026-09-01T00:00:00Z" }),
                  }),
                ]),
        },
        {
          match: `/pulls/${number}`,
          response: () => githubJson({ additions: 4 }, failed ? 503 : 200),
        },
        { match: "/check-runs", response: () => githubJson({ total_count: 0, check_runs: [] }) },
      ]);
      vi.stubGlobal("fetch", fetchImpl);
      const load = () =>
        loadControlUiSessionPullRequests(
          { sessionKey },
          { resolveGitContext: async () => ({ ...testGitContext, branch: "stale-preview" }) },
        );
      const fresh = failure === "cold metadata" ? undefined : await load();
      if (fresh) {
        expect(fresh.pullRequests[0]?.state).toBe(metadata ? "open" : "merged");
      }
      failed = true;
      vi.setSystemTime(Date.now() - (metadata ? 0 : 60_000));
      vi.advanceTimersByTime(91_000);
      if (metadata) {
        // Task-PR reads can cache a failed detail request before the branch list succeeds.
        await expect(
          readSessionPullRequestMetadata(
            { owner: "openclaw", repo: "openclaw", number },
            prepareSessionPullRequestGitHubRead("github.com", () => {}),
            async (transport) => {
              await transport.request(detailUrl);
              throw new Error("Expected the synthetic GitHub 503 response");
            },
          ),
        ).rejects.toMatchObject({ statusCode: 502 });
      }
      const stale = await load();
      expect(stale.pullRequests).toEqual(fresh?.pullRequests ?? []);
      expect(stale.status).toBe("unavailable");
      expect(stale.rateLimited).toBe(false);
      const calls = fetchImpl.mock.calls.length;
      expect(await load()).toEqual(stale);
      expect(fetchImpl.mock.calls).toHaveLength(calls);
      failed = false;
      vi.advanceTimersByTime(31_000);
      const recovered = await load();
      expect(recovered.status).not.toBe("unavailable");
      expect(recovered.pullRequests).toMatchObject([
        { number, state: metadata ? "open" : "merged" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  },
);

import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { createTestGatewayScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { awaitGateBeforeSettlement, withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiSessionPrReadContext } from "./control-ui-session-pr-read-api.js";
import {
  loadControlUiSessionPullRequests,
  readKnownSessionBranchMergedHeads,
} from "./control-ui-session-prs-api.js";
import { gitHubPublicApi } from "./public-api.js";
import { isGitHubPublicationSuperseded } from "./publication-relevance-api.js";
import { createTestControlUiSessionPrSubscriptions } from "./session-pr-subscriptions.test-support.js";
import {
  createSessionPullRequestsFixture,
  withTestSessionPrRead,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./session-prs.test-support.js";
const { prepareRead, load } = createSessionPullRequestsFixture();
let owner: ReturnType<typeof createTestControlUiSessionPrSubscriptions> | undefined;
afterEach(async () => {
  await owner?.stop();
  owner = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.for(["publication first", "display first", "refresh queued", "head changed"])(
  "reconciles a fourth merged PR without awaiting display details (%s)",
  async (order, { signal }) => {
    const head = "a".repeat(40);
    const tree = "b".repeat(40);
    const changedHead = order === "head changed" ? "c".repeat(40) : head;
    vi.spyOn(gitHubPublicApi, "resolveGitHubApiCredentialScope").mockReturnValue({
      token: undefined,
      cacheScope: `publication-${order}`,
      apiBaseUrl: "https://api.github.com",
    });
    const items = [5, 4, 3].map((number) =>
      pullListItem({ number, state: number === 5 ? "open" : "closed" }),
    );
    items.push(
      pullListItem({
        number: 2,
        state: "closed",
        merged_at: "2026-07-01T00:00:00Z",
        head: { sha: head },
      }),
    );
    const detailsStarted = createDeferred();
    const details = createDeferred();
    const refreshedDetails = createDeferred();
    let detailCalls = 0;
    const refreshStarted = createDeferred();
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson(items) },
      {
        match: "/pulls/5",
        response: async () => {
          const first = ++detailCalls === 1;
          detailsStarted.resolve();
          await (first ? details.promise : refreshedDetails.promise);
          return githubJson({ additions: first ? 4 : 8 });
        },
      },
      { match: "/check-runs", response: () => githubJson({ total_count: 0, check_runs: [] }) },
      {
        match: "/git/commits/" + head,
        response: () => githubJson({ sha: head, tree: { sha: tree } }),
      },
    ]);
    vi.stubGlobal("fetch", fetchImpl);
    const broadcastToConnIds = vi.fn();
    let displayLoads = 0;
    owner = createTestControlUiSessionPrSubscriptions({
      scheduler: createTestGatewayScheduler(),
      broadcastToConnIds,
      prepareRead,
      load: (params, cacheSignal, read) => {
        const refresh =
          (order === "refresh queued" || order === "head changed") &&
          read.projection !== "publication" &&
          ++displayLoads >= 2 &&
          (order === "head changed" || displayLoads === 2);
        if (refresh) {
          items[0] = { ...items[0], head: { sha: changedHead } };
        }
        const result = loadControlUiSessionPullRequests(
          { ...params, refresh },
          {
            cacheSignal,
            read: { ...read, target: { ...read.target, source: testGitContext } },
          },
        );
        if (refresh) {
          refreshStarted.resolve();
        }
        return result;
      },
    });
    const resolve = await prepareRead("connection", { sessionKey: "agent:main:main" });
    const target = await resolve();
    if (!target) {
      throw new Error("Missing fixture target");
    }
    const current = () => {};
    const displaying = order !== "publication first" ? owner.read(target, current) : undefined;
    if (displaying) {
      await withinTest(detailsStarted.promise, signal);
    }
    const refreshing =
      order === "refresh queued" || order === "head changed"
        ? owner.read(target, current)
        : undefined;
    if (refreshing) {
      await withinTest(refreshStarted.promise, signal);
    }
    const reading = owner.read(target, current, "publication");
    let candidates: Awaited<typeof reading>;
    try {
      candidates = await withinTest(
        displaying
          ? reading
          : awaitGateBeforeSettlement(
              reading,
              detailsStarted.promise,
              "Publication started optional display details",
            ),
        signal,
      );
      if (order === "head changed" && refreshing) {
        expect(candidates.pullRequests[0]?.headSha).toBe(changedHead);
        refreshedDetails.resolve();
        expect((await withinTest(refreshing, signal)).pullRequests[0]).toMatchObject({
          headSha: changedHead,
          additions: 8,
        });
      }
    } finally {
      details.resolve();
      refreshedDetails.resolve();
      await Promise.all([reading, displaying, refreshing]);
    }
    const displayed = await (refreshing ?? displaying ?? owner.read(target, current));
    expect(displayed.pullRequests.map((pr) => pr.number)).toEqual([5, 4, 3]);
    expect(displayed.pullRequests[0]?.additions).toBe(order === "head changed" ? 8 : 4);
    expect(candidates.pullRequests.map((pr) => pr.number)).toEqual([5, 4, 3, 2]);
    const snapshot = {
      repository: "openclaw/openclaw",
      branch: testGitContext.branch,
      sourceHeadCommit: head,
      workspaceTree: tree,
    };
    expect(
      await isGitHubPublicationSuperseded(snapshot, async () => ({
        pullRequests: candidates.pullRequests,
        assertCurrent: current,
      })),
    ).toBe(true);
    expect(
      await isGitHubPublicationSuperseded(
        { ...snapshot, workspaceTree: "c".repeat(40) },
        async () => ({ pullRequests: candidates.pullRequests, assertCurrent: current }),
      ),
    ).toBe(false);
    expect((await owner.read(target, current)).pullRequests).toEqual(displayed.pullRequests);
    if (order === "head changed") {
      expect(detailCalls).toBe(2);
      expect(
        fetchImpl.mock.calls.some(
          ([url]) => typeof url === "string" && url.includes(`/commits/${changedHead}/check-runs`),
        ),
      ).toBe(true);
    }
    expect(displayed).not.toHaveProperty("publicationCandidates");
    expect(candidates).not.toHaveProperty("publicationCandidates");
    expect(displayed).not.toHaveProperty("enrichment");
    expect(candidates).not.toHaveProperty("enrichment");
    expect(
      fetchImpl.mock.calls.filter(
        ([url]) => typeof url === "string" && url.includes("/pulls?head="),
      ),
    ).toHaveLength(order === "head changed" ? 3 : refreshing ? 2 : 1);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  },
);

it("reads known merged heads without network access only for the same live session, source and credential", async () => {
  let cacheScope = "known-merged-heads";
  vi.spyOn(gitHubPublicApi, "resolveGitHubApiCredentialScope").mockImplementation(() => ({
    token: undefined,
    cacheScope,
    apiBaseUrl: "https://api.github.com",
  }));
  const head = "a".repeat(40);
  const mergeCommitSha = "b".repeat(40);
  const fetchImpl = routedFetch([
    {
      match: "/pulls?head=",
      response: () =>
        githubJson([
          pullListItem({
            state: "closed",
            merged_at: "2026-07-01T00:00:00Z",
            head: { sha: head },
            merge_commit_sha: mergeCommitSha,
          }),
          pullListItem({ number: 103470, state: "closed", head: { sha: "c".repeat(40) } }),
        ]),
    },
  ]);
  vi.stubGlobal("fetch", fetchImpl);
  const sessionKey = "agent:main:known-merged-heads";
  await load({ sessionKey }, { resolveGitContext: async () => testGitContext });
  expect(fetchImpl).toHaveBeenCalledOnce();
  const resolve = await prepareRead("connection", { sessionKey });
  const resolveOther = await prepareRead("connection", {
    sessionKey: "agent:main:other-merged-heads",
  });
  const target = await resolve();
  const otherTarget = await resolveOther();
  if (!target || !otherTarget) {
    throw new Error("Missing fixture target");
  }
  const network = vi.fn<typeof fetch>().mockRejectedValue(new Error("Unexpected cache fetch"));
  vi.stubGlobal("fetch", network);
  const expected = [{ sha: head, baseRef: "main", mergeCommitSha }];
  let releasedRead: ControlUiSessionPrReadContext | undefined;
  await withTestSessionPrRead(target, async (read) => {
    releasedRead = read;
    const known = readKnownSessionBranchMergedHeads(testGitContext, read);
    expect(known).toEqual(expected);
    known[0]!.sha = "d".repeat(40);
    expect(readKnownSessionBranchMergedHeads(testGitContext, read)).toEqual(expected);
    expect(
      readKnownSessionBranchMergedHeads(testGitContext, { ...read, target: otherTarget }),
    ).toEqual([]);
    expect(
      readKnownSessionBranchMergedHeads({ ...testGitContext, branch: "other-branch" }, read),
    ).toEqual([]);
    cacheScope = "replacement-credential";
    expect(readKnownSessionBranchMergedHeads(testGitContext, read)).toEqual([]);
    cacheScope = "known-merged-heads";
    expect(readKnownSessionBranchMergedHeads(testGitContext, read)).toEqual(expected);
  });
  expect(() => readKnownSessionBranchMergedHeads(testGitContext, releasedRead!)).toThrow(
    /Fixture source scope retired/,
  );

  expect(network).not.toHaveBeenCalled();
  expect(fetchImpl).toHaveBeenCalledOnce();
});

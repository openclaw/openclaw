import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatControlUiGitHubPreviewError } from "./github-api.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import {
  loadControlUiGitHubPreview as loadPreview,
  parseControlUiGitHubPreviewTarget,
} from "./preview.js";
import {
  avatarDataUrl,
  coauthorTrailers,
  conditionalPreviewFixture,
  githubJson,
  githubRedirect,
  managedIdentity,
  pngResponse,
  previewPayload,
  previewFetch,
  previewTarget,
  publicRepository,
  requestUrl,
} from "./preview.test-support.js";

const optionalIdentity = (): ControlUiGitHubPreviewIdentity => ({
  ...managedIdentity("fixture-github-test-token"),
  token: "github-test-token",
  optionalAuth: true,
});
function responses(...items: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of items) {
    fetchMock.mockResolvedValueOnce(response);
  }
  return fetchMock;
}
function deferredFirstResponse(next: (url: string) => Response) {
  const started = createDeferred<void>();
  const response = createDeferred<Response>();
  const fetchMock = previewFetch((url) => {
    if (fetchMock.mock.calls.length !== 1) {
      return next(url);
    }
    started.resolve();
    return response.promise;
  });
  return { started, response, fetchMock };
}
const itemResponse = (overrides: Record<string, unknown> = {}) =>
  githubJson(previewPayload(overrides));
const authorOnly = (overrides: Record<string, unknown> = {}) =>
  itemResponse({ user: { login: "octocat" }, ...overrides });
const commitResponse = (message: string) => githubJson([{ commit: { message } }]);
const adaTrailer = "Co-authored-by: Ada <20+ada@users.noreply.github.com>";
const expectStatus = (pending: Promise<unknown>, statusCode: number) =>
  expect(pending).rejects.toMatchObject({ statusCode });
const expectPreview = (
  pending: ReturnType<typeof loadPreview>,
  expected: Partial<Awaited<ReturnType<typeof loadPreview>>>,
) => expect(pending).resolves.toMatchObject(expected);
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

it.each([
  ["kind", "comment"],
  ["repo", ".."],
  ["repo", "repo.git"],
  ["repo", "repo.atom"],
  ["number", 1.5],
  ["agentId", " "],
])("rejects invalid %s: %s", (field, value) => {
  expect(parseControlUiGitHubPreviewTarget({ ...previewTarget(1), [field]: value })).toBeNull();
});

describe("loadControlUiGitHubPreview", () => {
  beforeEach(() => {
    vi.stubEnv("GH_TOKEN", "ignored-ambient-preview-token");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  afterEach(async () => {
    if (vi.isFakeTimers()) {
      await vi.runAllTimersAsync();
      vi.useRealTimers();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each(["repository", "body", "commits", "co-author avatar"])(
    "bounds slow %s reads with the preview deadline and reuses the settled cache",
    async (stage) => {
      vi.useFakeTimers();
      // Native AbortSignal timers do not use Vitest's clock.
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
        return controller.signal;
      });
      const identity = managedIdentity(`deadline-${stage}`);
      const fetchMock = previewFetch(async (url, init) => {
        const signal = init?.signal;
        if (!signal) {
          throw new Error("Expected cancellable GitHub transport");
        }
        const currentStage = url.endsWith("/repos/openclaw/openclaw")
          ? "repository"
          : url.includes("/commits")
            ? "commits"
            : url.includes("/u/20")
              ? "co-author avatar"
              : url.includes("avatars.")
                ? "avatar"
                : "item";
        if (currentStage === stage || (stage === "body" && currentStage === "item")) {
          if (stage === "body") {
            return new Response(
              new ReadableStream({
                start(controller) {
                  signal.addEventListener("abort", () => controller.error(signal.reason), {
                    once: true,
                  });
                },
              }),
            );
          }
          return new Promise<Response>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("Aborted", "AbortError")),
              { once: true },
            );
          });
        }
        // Metadata/commits consume budget before a later slow request starts.
        await delay(200);
        if (currentStage === "repository") {
          return publicRepository();
        }
        if (currentStage === "commits") {
          return commitResponse(adaTrailer);
        }
        return currentStage === "item" ? itemResponse() : pngResponse();
      });
      const target = previewTarget(930307, "pull");
      const settled = vi.fn();
      const load = () =>
        loadPreview(target, identity, fetchMock).then(
          (preview) => ({ preview }),
          (error: unknown) => ({ error: formatControlUiGitHubPreviewError(error) }),
        );
      const pending = load().then(settled);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(settled).toHaveBeenCalledExactlyOnceWith(
        ["repository", "body"].includes(stage)
          ? { error: expect.objectContaining({ retryable: true }) }
          : { preview: expect.objectContaining({ login: "steipete" }) },
      );
      await pending;
      const calls = fetchMock.mock.calls.length;
      expect(await load()).toEqual(settled.mock.calls[0]?.[0]);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
      expect(identity.revalidate).toHaveBeenCalled();
    },
  );

  it("delivers a cached preview after one live credential read", async () => {
    vi.useFakeTimers();
    const identity = managedIdentity("slow-cached-credential");
    const fetchMock = previewFetch((url) =>
      url.endsWith("/repos/openclaw/openclaw") ? publicRepository() : authorOnly(),
    );
    const target = previewTarget(940004);
    const load = () => loadPreview(target, identity, fetchMock);
    await load();
    const calls = fetchMock.mock.calls.length;
    identity.revalidate.mockImplementation(async () => {
      await delay(750);
      identity.assertSelected();
    });
    const delivered = vi.fn();
    const pending = load().then(delivered);
    await vi.advanceTimersByTimeAsync(750);
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ login: "octocat" }));
    expect(fetchMock).toHaveBeenCalledTimes(calls);
    await pending;
  });

  it.each(["final visibility check", "repository redirect", "commits redirect"])(
    "blocks later GitHub dispatches after identity changes during %s",
    async (stage) => {
      let changed = false;
      let repositoryReads = 0;
      const dispatchesAfterChange: string[] = [];
      const assertSelected = () => {
        if (changed) {
          throw Object.assign(new Error("identity changed"), { reason: "changed" });
        }
      };
      const identity = managedIdentity(`inflight-preview-identity-${stage}`, assertSelected);
      const fetchMock = previewFetch(async (url) => {
        if (changed) {
          dispatchesAfterChange.push(url);
        }
        if (url.endsWith("/repos/openclaw/openclaw")) {
          repositoryReads += 1;
        }
        if (
          (stage === "repository redirect" && repositoryReads === 1) ||
          (stage === "final visibility check" && repositoryReads === 2) ||
          (stage === "commits redirect" && url.includes("/commits"))
        ) {
          changed = true;
          if (stage !== "final visibility check") {
            return new Response(null, {
              status: 301,
              headers: { Location: url.replace("/openclaw/openclaw", "/openclaw/renamed") },
            });
          }
        }
        return githubJson(
          url.includes("/commits")
            ? []
            : url.includes("/pulls/")
              ? previewPayload({ user: { login: "octocat" } })
              : { private: false, visibility: "public" },
        );
      });
      await expect(
        loadPreview(previewTarget(88123, "pull"), identity, fetchMock),
      ).rejects.toMatchObject({ reason: "changed" });
      expect(changed).toBe(true);
      expect(dispatchesAfterChange).toEqual([]);
    },
  );

  it("returns expired previews while one refresh runs and revalidates every reader", async ({
    signal,
  }) => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const refresh = createDeferred<Response>();
    const refreshStarted = createDeferred<void>();
    const identity = managedIdentity("stale-preview");
    const target = previewTarget(88126);
    let refreshing = false;
    const fetchMock = previewFetch(async (url) => {
      if (!url.includes("/issues/")) {
        return publicRepository();
      }
      if (!refreshing) {
        return authorOnly();
      }
      refreshStarted.resolve();
      return refresh.promise.then((response) => response.clone());
    });
    const load = (force = false) => loadPreview(target, identity, fetchMock, force);
    const first = await load();
    // Expire only metadata; delivery must not join the deferred refresh.
    now += 60_000;
    const expired = now;
    refreshing = true;
    const stale = { ...first, stale: true };
    try {
      expect(await withinTest(load(), signal)).toEqual(stale);
      expect(await load()).toEqual(stale);
      await withinTest(refreshStarted.promise, signal);
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes("/issues/")),
      ).toHaveLength(2);
      const forced = load(true);
      refresh.resolve(authorOnly({ title: "Refreshed" }));
      await expectPreview(forced, { title: "Refreshed" });
      now = expired + 1;
      await expectPreview(load(), { title: "Refreshed" });
      identity.revalidate.mockRejectedValue(new Error("identity retired"));
      await expect(load()).rejects.toThrow("identity retired");
    } finally {
      refresh.resolve(itemResponse());
    }
  });

  it.each(["issue", "pull"] as const)(
    "overlaps %s avatars with final visibility validation without publishing private metadata",
    async (kind) => {
      vi.useFakeTimers();
      for (const isPublic of [true, false]) {
        let repositoryReads = 0;
        const started: string[] = [];
        const fetchMock = previewFetch(async (url) => {
          started.push(
            url.includes("/commits")
              ? "commits"
              : url.includes("/pulls/") || url.includes("/issues/")
                ? "item"
                : "other",
          );
          await delay(100);
          if (url.includes("avatars.githubusercontent.com")) {
            return pngResponse();
          }
          if (url.includes("/commits")) {
            return commitResponse(adaTrailer);
          }
          if (url.endsWith("/repos/openclaw/openclaw")) {
            repositoryReads += 1;
            return repositoryReads === 1 || isPublic
              ? publicRepository()
              : githubJson({ private: true, visibility: "private" });
          }
          return itemResponse();
        });
        const settled = vi.fn();
        const pending = loadPreview(
          previewTarget(88128, kind),
          managedIdentity(`overlap-${kind}-${isPublic}`),
          fetchMock,
        ).then(
          (preview) => settled({ preview }),
          (error: unknown) => settled({ error }),
        );
        await vi.advanceTimersByTimeAsync(100);
        // Admission completed; item and commits must both start before either response resolves.
        expect(started).toEqual(kind === "pull" ? ["other", "item", "commits"] : ["other", "item"]);
        await vi.advanceTimersByTimeAsync(199);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        const preview =
          kind === "pull"
            ? { avatarDataUrl, coAuthors: [{ login: "ada", avatarDataUrl }] }
            : { avatarDataUrl };
        expect(settled).toHaveBeenCalledExactlyOnceWith(
          isPublic
            ? { preview: expect.objectContaining(preview) }
            : { error: expect.objectContaining({ statusCode: 404 }) },
        );
        await pending;
      }
    },
  );

  it("evicts a disconnected caller's failed cold load for the next request", async () => {
    let connected = true;
    const identity = managedIdentity("shared-preview-identity", () => {
      if (!connected) {
        throw Object.assign(new Error("identity changed"), { reason: "changed" });
      }
    });
    const follower = managedIdentity("shared-preview-identity");
    const f = deferredFirstResponse((url) =>
      url.includes("/issues/") ? authorOnly() : publicRepository(),
    );
    const { fetchMock } = f;
    const fixtureTarget = previewTarget(88125);
    const first = loadPreview(fixtureTarget, identity, fetchMock);
    const rejected = expect(first).rejects.toMatchObject({ reason: "changed" });
    await f.started.promise;
    const second = loadPreview(fixtureTarget, follower, fetchMock);
    const secondRejected = expect(second).rejects.toMatchObject({ reason: "changed" });
    connected = false;
    f.response.resolve(publicRepository());
    await rejected;
    await secondRejected;
    await expectPreview(loadPreview(fixtureTarget, follower, fetchMock), { login: "octocat" });
    const calls = fetchMock.mock.calls.length;
    await expectPreview(loadPreview(fixtureTarget, follower, fetchMock), { login: "octocat" });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("does not retry a selected identity authentication failure anonymously", async () => {
    const identity = managedIdentity("selected-preview-identity");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(githubJson({}, 401));
    await expectStatus(loadPreview(previewTarget(88124), identity, fetchMock), 401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves co-authors from noreply trailers without a lookup per person", async () => {
    // Large pages, line-bounded trailers, duplicate/self/plain-address exclusion, and the face cap.
    const messages = [
      `${"x".repeat(300 * 1024)}\n\nCo-authored-by:\t Ada King \t<20+ada@users.noreply.github.com>\t`,
      ...["\n", "\r", "\u2028", "\u2029"].map(
        (separator, index) =>
          `Co-authored-by: Invalid${separator}continued <${80 + index}+invalid-${index}@users.noreply.github.com>`,
      ),
      "fix: two\n\nCo-authored-by: ada <20+ADA@users.noreply.github.com>",
      "Co-authored-by: Someone <someone@example.com>",
    ].map((message) => ({ commit: { message } }));
    messages.push(
      ...coauthorTrailers(["Mira", 7], ["steipete", 58493], ["Alan", 31], ["Grace", 99]),
    );
    const fetchMock = previewFetch(async (url) => {
      if (url.includes("/commits")) {
        return githubJson(messages);
      }
      if (url.includes("avatars.githubusercontent.com")) {
        return pngResponse();
      }
      return itemResponse();
    });

    const preview = await loadPreview(previewTarget(88101, "pull"), undefined, fetchMock);

    expect(preview).toMatchObject({
      additions: 101,
      deletions: 12,
      changedFiles: 3,
      avatarDataUrl,
      kind: "pull",
      login: "steipete",
      mergedAt: "2026-07-04T09:53:52Z",
      number: 88101,
      owner: "openclaw",
      repo: "openclaw",
    });
    expect(preview.coAuthorCount).toBe(4);
    expect(preview.coAuthors).toEqual([
      { login: "ada", avatarDataUrl },
      { login: "mira", avatarDataUrl },
      { login: "alan", avatarDataUrl },
    ]);
    // Noreply account IDs supply bounded avatars without per-person API lookups.
    const urls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(urls.filter((url) => url.startsWith("https://api.github.com/"))).toEqual([
      "https://api.github.com/repos/openclaw/openclaw/pulls/88101",
      "https://api.github.com/repos/openclaw/openclaw/pulls/88101/commits?per_page=100",
    ]);
    expect(urls.filter((url) => url.startsWith("https://avatars.githubusercontent.com/"))).toEqual(
      [58493, 20, 7, 31].map((id) => `https://avatars.githubusercontent.com/u/${id}?s=64`),
    );
  });

  it.each([
    "https://example.com/avatar.png",
    "https://avatars.githubusercontent.com/u/58493?v=4#fragment",
    "https://avatars.githubusercontent.com/u/../58493?v=4",
    "https://avatars.githubusercontent.com/u\\58493?v=4",
  ])("does not fetch unsafe avatar URL %s", async (avatar_url) => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(authorOnly({ user: { avatar_url, login: "octocat" } }));
    const preview = await loadPreview(previewTarget(70001), undefined, fetchMock);
    expect(preview.avatarDataUrl).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards rejected avatar response bodies", async () => {
    const avatarResponse = new Response("not an image", {
      headers: { "Content-Type": "text/plain" },
    });
    const fetchMock = responses(itemResponse(), avatarResponse);

    const preview = await loadPreview(
      previewTarget(70009, "issue", "bad-avatar"),
      undefined,
      fetchMock,
    );

    expect(preview.avatarDataUrl).toBeUndefined();
    expect(avatarResponse.bodyUsed).toBe(true);
  });

  it("follows GitHub API redirects for renamed public repositories", async () => {
    const identity = optionalIdentity();
    const fetchMock = responses(
      publicRepository(),
      githubRedirect("/repos/openclaw/renamed/issues/70007"),
      publicRepository(),
      authorOnly({ repository_url: "https://api.github.com/repos/openclaw/renamed" }),
      publicRepository(),
    );

    const preview = await loadPreview(
      previewTarget(70007, "issue", "old-name"),
      identity,
      fetchMock,
    );

    expect(preview.login).toBe("octocat");
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "https://api.github.com/repos/openclaw/old-name",
      "https://api.github.com/repos/openclaw/old-name/issues/70007",
      "https://api.github.com/repos/openclaw/renamed",
      "https://api.github.com/repos/openclaw/renamed/issues/70007",
      "https://api.github.com/repos/openclaw/renamed",
    ]);
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1]?.headers).get("Authorization")).toBe("Bearer github-test-token");
      expect(call[1]?.redirect).toBe("manual");
    }
  });

  it("re-checks visibility when the commits request is redirected into another repository", async () => {
    const identity = optionalIdentity();
    const visibilityChecks: string[] = [];
    const fetchMock = previewFetch(async (url) => {
      if (url.endsWith("/repos/openclaw/openclaw")) {
        visibilityChecks.push(url);
        return publicRepository();
      }
      if (url.endsWith("/repos/openclaw/secret")) {
        visibilityChecks.push(url);
        // The token can read it; the Control UI viewer must not.
        return githubJson({ private: true });
      }
      if (url.includes("/commits")) {
        return new Response("moved", {
          status: 301,
          headers: {
            Location: "https://api.github.com/repos/openclaw/secret/pulls/88201/commits",
          },
        });
      }
      if (url.includes("avatars.githubusercontent.com")) {
        return pngResponse();
      }
      return itemResponse();
    });

    const preview = await loadPreview(previewTarget(88201, "pull"), identity, fetchMock);

    // The card still renders; only the co-author decoration is withheld.
    expect(preview.login).toBe("steipete");
    expect(preview.coAuthors).toBeUndefined();
    // The redirect target was visibility-checked, and its commits were never fetched.
    expect(visibilityChecks).toContain("https://api.github.com/repos/openclaw/secret");
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        requestUrl(input).startsWith("https://api.github.com/repos/openclaw/secret/pulls"),
      ),
    ).toHaveLength(0);
  });

  it.each([false, true])("withholds private metadata (transferred=%s)", async (transferred) => {
    const identity = optionalIdentity();
    const privateRepo = githubJson(
      transferred ? { private: true } : { private: true, visibility: "private" },
    );
    const fetchMock = responses(
      ...(transferred
        ? [publicRepository(), githubRedirect("/repos/openclaw/private/issues/70004"), privateRepo]
        : [privateRepo]),
    );
    const target = previewTarget(
      transferred ? 70004 : 70010,
      "issue",
      transferred ? "public-source" : "private",
    );
    await expectStatus(loadPreview(target, identity, fetchMock), 404);
    expect(fetchMock).toHaveBeenCalledTimes(transferred ? 3 : 1);
    if (transferred) {
      for (const [, init] of fetchMock.mock.calls.slice(1)) {
        expect(init?.headers).toHaveProperty("Authorization", "Bearer github-test-token");
      }
    } else {
      expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
        "https://api.github.com/repos/openclaw/private",
      );
    }
  });

  it.each(["issue", "pull"] as const)(
    "conditionally revalidates %s metadata and retires validators after an error",
    async (kind) => {
      const f = conditionalPreviewFixture(kind, 940001, {
        identity: managedIdentity(`conditional-${kind}`),
        avatarUrl: null,
      });
      f.state.login = "octocat";
      const load = (force = false) => f.load(force);
      const first = await load();
      const before = f.transport.mock.calls.length;
      expect(await load()).toEqual(first);
      expect(f.transport).toHaveBeenCalledTimes(before);
      expect(await load(true)).toEqual(first);
      f.state.item = f.state.commits = 2;
      expect(await load(true)).toMatchObject({ title: "Version 2" });
      expect(await load(true)).toMatchObject({ title: "Version 2" });
      f.state.unavailable = true;
      await expectStatus(load(true), 404);
      f.state.unavailable = false;
      expect(await load(true)).toMatchObject({ title: "Version 2" });
      expect(f.itemHeaders).toEqual([null, '"item-1"', '"item-1"', '"item-2"', '"item-2"', null]);
      expect(f.commitsHeaders).toEqual(
        kind === "pull"
          ? [null, '"commits-1"', '"commits-1"', '"commits-2"', '"commits-2"', null]
          : [],
      );
    },
  );

  it("does not reuse representations across transports, token rotations, or anonymous fallback", async () => {
    const f = conditionalPreviewFixture("issue", 940002, {
      avatarResponse: pngResponse,
      honorValidators: false,
    });
    const { target, transport: fetchMock } = f;
    const identity = {
      ...managedIdentity("representation-isolation"),
      optionalAuth: true as const,
    };
    await loadPreview(target, identity, fetchMock);
    const rotated = { ...identity, token: "rotated-fixture-token" };
    await loadPreview(target, rotated, fetchMock);
    const secondTransport: typeof fetch = (input, init) => fetchMock(input, init);
    await loadPreview(target, identity, secondTransport);
    await loadPreview(target, { ...identity, cacheScope: "another-reader-scope" }, fetchMock);
    const normal = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) =>
      new Headers(init?.headers).has("Authorization") ? githubJson({}, 401) : normal(input, init),
    );
    await loadPreview(target, identity, fetchMock, true);
    fetchMock.mockImplementation(normal);
    await loadPreview(target, identity, fetchMock, true);
    expect(f.itemHeaders).toEqual([null, null, null, null, null, null]);
    // Anonymous avatar bytes are shared; credentialed representations stay isolated.
    expect(f.avatars).toHaveLength(2);
  });

  it.each(["private", "retired"])(
    "rejects %s access after a conditional item response",
    async (cause) => {
      let retired = false;
      const identity = managedIdentity("conditional-private", () => {
        if (retired) {
          throw new Error("identity retired");
        }
      });
      const f = conditionalPreviewFixture("issue", 940003, {
        identity,
        avatarResponse: pngResponse,
        repository: (reads) => {
          if (reads !== 4) {
            return publicRepository();
          }
          retired = cause === "retired";
          return retired ? publicRepository() : githubJson({ private: true });
        },
      });
      await f.load(false);
      const refreshed = f.load();
      if (cause === "retired") {
        await expect(refreshed).rejects.toThrow("identity retired");
      } else {
        await expectStatus(refreshed, 404);
      }
      expect(f.avatars).toHaveLength(1);
    },
  );

  it("does not let a failed older request replace an explicit refresh", async () => {
    const f = deferredFirstResponse(() => authorOnly({ title: "Refreshed preview" }));
    const { fetchMock } = f;
    const fixtureTarget = previewTarget(70015, "issue", "refresh-order");
    const pending = loadPreview(fixtureTarget, undefined, fetchMock);
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 404 });
    await f.started.promise;
    await expectPreview(loadPreview(fixtureTarget, undefined, fetchMock, true), {
      title: "Refreshed preview",
    });
    const missingResponse = githubJson({}, 404);
    f.response.resolve(missingResponse);
    await rejected;
    expect(missingResponse.bodyUsed).toBe(true);
    await expectPreview(loadPreview(fixtureTarget, undefined, fetchMock), {
      title: "Refreshed preview",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

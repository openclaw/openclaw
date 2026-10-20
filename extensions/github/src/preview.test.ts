import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatControlUiGitHubPreviewError } from "./github-api.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import {
  loadControlUiGitHubPreview as loadPluginPreview,
  parseControlUiGitHubPreviewTarget,
} from "./preview.js";
import {
  githubJson,
  githubRedirect,
  managedIdentity,
  pngResponse,
  previewPayload,
  previewTarget,
  publicRepository,
  requestUrl,
} from "./preview.test-support.js";

let fixtureIdentity: ControlUiGitHubPreviewIdentity | undefined;
function selectFixtureToken(token: string) {
  fixtureIdentity = { ...managedIdentity("fixture-" + token), token, optionalAuth: true };
}
function loadPreview(...args: Parameters<typeof loadPluginPreview>) {
  const [target, identity = fixtureIdentity, fetchImpl, refresh] = args;
  return loadPluginPreview(target, identity, fetchImpl, refresh);
}

const itemResponse = (overrides: Record<string, unknown> = {}) =>
  githubJson(previewPayload(overrides));
const authorOnly = (overrides: Record<string, unknown> = {}) =>
  itemResponse({ user: { login: "octocat" }, ...overrides });
const commitResponse = (message: string) => githubJson([{ commit: { message } }]);
const adaTrailer = "Co-authored-by: Ada <20+ada@users.noreply.github.com>";
const avatarDataUrl = "data:image/png;base64,iVBORw==";
function previewFetch(respond: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  return vi.fn<typeof fetch>(async (input, init) => respond(requestUrl(input), init));
}

describe("parseControlUiGitHubPreviewTarget", () => {
  const target = { kind: "issue", number: 1, owner: "openclaw", repo: "openclaw" };

  it.each([
    ["kind", "comment"],
    ["repo", ".."],
    ["repo", "repo.git"],
    ["repo", "repo.atom"],
    ["number", 1.5],
    ["agentId", " "],
  ])("rejects invalid %s: %s", (field, value) => {
    expect(parseControlUiGitHubPreviewTarget({ ...target, [field]: value })).toBeNull();
  });
});

describe("loadControlUiGitHubPreview", () => {
  beforeEach(() => {
    fixtureIdentity = undefined;
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
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 200);
        });
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
      expect(settled).toHaveBeenCalledOnce();
      if (["repository", "item", "body"].includes(stage)) {
        expect(settled).toHaveBeenCalledWith({
          error: expect.objectContaining({ retryable: true }),
        });
      } else {
        expect(settled).toHaveBeenCalledWith({
          preview: expect.objectContaining({ login: "steipete" }),
        });
      }
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
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async (input) =>
        requestUrl(input).endsWith("/repos/openclaw/openclaw") ? publicRepository() : authorOnly(),
      );
    const target = previewTarget(940004);
    await loadPreview(target, identity, fetchMock);
    const calls = fetchMock.mock.calls.length;
    identity.revalidate.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 750);
      });
      identity.assertSelected();
    });
    const delivered = vi.fn();
    const pending = loadPreview(target, identity, fetchMock).then(delivered);
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
    const fetchMock = previewFetch(async (url) => {
      if (url.includes("/issues/")) {
        return authorOnly();
      }
      return publicRepository();
    });
    const first = await loadPreview(target, identity, fetchMock);
    // Expire only metadata; a deferred response proves request delivery never joins its refresh.
    now += 60_000;
    const expired = now;
    fetchMock.mockImplementation(async (input) => {
      if (requestUrl(input).includes("/issues/")) {
        refreshStarted.resolve();
        return refresh.promise.then((response) => response.clone());
      }
      return publicRepository();
    });
    try {
      expect(await withinTest(loadPreview(target, identity, fetchMock), signal)).toEqual({
        ...first,
        stale: true,
      });
      expect(await loadPreview(target, identity, fetchMock)).toEqual({
        ...first,
        stale: true,
      });
      await withinTest(refreshStarted.promise, signal);
      expect(
        fetchMock.mock.calls.filter(([input]) => requestUrl(input).includes("/issues/")),
      ).toHaveLength(2);
      const forced = loadPreview(target, identity, fetchMock, true);
      refresh.resolve(authorOnly({ title: "Refreshed" }));
      await expect(forced).resolves.toMatchObject({ title: "Refreshed" });
      now = expired + 1;
      await expect(loadPreview(target, identity, fetchMock)).resolves.toMatchObject({
        title: "Refreshed",
      });
      identity.revalidate.mockRejectedValue(new Error("identity retired"));
      await expect(loadPreview(target, identity, fetchMock)).rejects.toThrow("identity retired");
    } finally {
      refresh.resolve(itemResponse());
    }
  });

  it("starts PR metadata and commits together after public admission", async () => {
    const itemStarted = createDeferred<void>();
    const item = createDeferred<Response>();
    let commitsStarted = false;
    const fetchMock = previewFetch(async (url) => {
      if (url.includes("/commits")) {
        commitsStarted = true;
        return githubJson([]);
      }
      if (url.includes("/pulls/")) {
        itemStarted.resolve();
        return item.promise;
      }
      return publicRepository();
    });
    const pending = loadPreview(
      previewTarget(88127, "pull"),
      managedIdentity("parallel-preview"),
      fetchMock,
    );
    await itemStarted.promise;
    try {
      expect(commitsStarted).toBe(true);
    } finally {
      item.resolve(authorOnly());
      await pending;
    }
  });

  it.each(["issue", "pull"] as const)(
    "overlaps %s avatars with final visibility validation without publishing private metadata",
    async (kind) => {
      vi.useFakeTimers();
      for (const isPublic of [true, false]) {
        let repositoryReads = 0;
        const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 100);
          });
          const url = requestUrl(input);
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
        await vi.advanceTimersByTimeAsync(299);
        expect(settled).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalledExactlyOnceWith(
          isPublic
            ? {
                preview: expect.objectContaining({
                  avatarDataUrl,
                  ...(kind === "pull"
                    ? {
                        coAuthors: [{ login: "ada", avatarDataUrl }],
                      }
                    : {}),
                }),
              }
            : { error: expect.objectContaining({ statusCode: 404 }) },
        );
        await pending;
      }
    },
  );

  it("evicts a disconnected caller's failed cold load for the next request", async () => {
    const started = createDeferred<void>();
    const repository = createDeferred<Response>();
    let connected = true;
    const identity = managedIdentity("shared-preview-identity", () => {
      if (!connected) {
        throw Object.assign(new Error("identity changed"), { reason: "changed" });
      }
    });
    const follower = managedIdentity("shared-preview-identity");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      if (fetchMock.mock.calls.length === 1) {
        started.resolve();
        return repository.promise;
      }
      return githubJson(
        requestUrl(input).includes("/issues/")
          ? previewPayload({ user: { login: "octocat" } })
          : { private: false, visibility: "public" },
      );
    });
    const fixtureTarget = previewTarget(88125);
    const first = loadPreview(fixtureTarget, identity, fetchMock);
    const rejected = expect(first).rejects.toMatchObject({ reason: "changed" });
    await started.promise;
    const second = loadPreview(fixtureTarget, follower, fetchMock);
    const secondRejected = expect(second).rejects.toMatchObject({ reason: "changed" });
    connected = false;
    repository.resolve(publicRepository());
    await rejected;
    await secondRejected;
    await expect(loadPreview(fixtureTarget, follower, fetchMock)).resolves.toMatchObject({
      login: "octocat",
    });
    const calls = fetchMock.mock.calls.length;
    await expect(loadPreview(fixtureTarget, follower, fetchMock)).resolves.toMatchObject({
      login: "octocat",
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("does not retry a selected identity authentication failure anonymously", async () => {
    const identity = managedIdentity("selected-preview-identity");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(githubJson({}, 401));
    await expect(loadPreview(previewTarget(88124), identity, fetchMock)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves co-authors from noreply trailers without a lookup per person", async () => {
    const messages = [
      // A commits page can exceed the shared 256 KiB JSON default.
      `${"x".repeat(300 * 1024)}\n\nCo-authored-by:\t Ada King \t<20+ada@users.noreply.github.com>\t`,
      ...["\n", "\r", "\u2028", "\u2029"].map(
        (separator, index) =>
          `Co-authored-by: Invalid${separator}continued <${80 + index}+invalid-${index}@users.noreply.github.com>`,
      ),
      // Repeat plus a different case: the same person must fold into one face.
      "fix: two\n\nCo-authored-by: ada <20+ADA@users.noreply.github.com>",
      "fix: three\n\nCo-authored-by: Mira <7+mira@users.noreply.github.com>",
      // The PR author is not their own co-author.
      "fix: four\n\nCo-authored-by: steipete <58493+steipete@users.noreply.github.com>",
      // A plain address carries no account id, so it cannot resolve to a face.
      "fix: five\n\nCo-authored-by: Someone <someone@example.com>",
      "fix: six\n\nCo-authored-by: Alan <31+alan@users.noreply.github.com>",
      "fix: seven\n\nCo-authored-by: Grace <99+grace@users.noreply.github.com>",
    ].map((message) => ({ commit: { message } }));
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
    // The account id in the trailer is the avatar, so no per-person API lookup.
    const urls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(urls.filter((url) => url.startsWith("https://api.github.com/"))).toEqual([
      "https://api.github.com/repos/openclaw/openclaw/pulls/88101",
      "https://api.github.com/repos/openclaw/openclaw/pulls/88101/commits?per_page=100",
    ]);
    expect(urls.filter((url) => url.startsWith("https://avatars.githubusercontent.com/"))).toEqual([
      "https://avatars.githubusercontent.com/u/58493?s=64",
      // Co-author avatars go through the same bounded ?s=64 normalization.
      "https://avatars.githubusercontent.com/u/20?s=64",
      "https://avatars.githubusercontent.com/u/7?s=64",
      "https://avatars.githubusercontent.com/u/31?s=64",
    ]);
  });

  it.each([
    ["https://example.com/avatar.png", 70001, "avatar-host"],
    ["https://avatars.githubusercontent.com/u/58493?v=4#fragment", 70002, "avatar-fragment"],
    ["https://avatars.githubusercontent.com/u/../58493?v=4", 70003, "avatar-dot-segment"],
    ["https://avatars.githubusercontent.com/u\\58493?v=4", 70004, "avatar-backslash"],
  ])("does not fetch unsafe avatar URL %s", async (avatarUrl, number, repo) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      githubJson(
        previewPayload({
          user: { avatar_url: avatarUrl, login: "octocat" },
        }),
      ),
    );

    const preview = await loadPreview(
      { kind: "issue", number, owner: "openclaw", repo },
      undefined,
      fetchMock,
    );

    expect(preview.avatarDataUrl).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("discards rejected avatar response bodies", async () => {
    const avatarResponse = new Response("not an image", {
      headers: { "Content-Type": "text/plain" },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(itemResponse())
      .mockResolvedValueOnce(avatarResponse);

    const preview = await loadPreview(
      previewTarget(70009, "issue", "bad-avatar"),
      undefined,
      fetchMock,
    );

    expect(preview.avatarDataUrl).toBeUndefined();
    expect(avatarResponse.bodyUsed).toBe(true);
  });

  it("follows GitHub API redirects for renamed public repositories", async () => {
    selectFixtureToken("github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(publicRepository())
      .mockResolvedValueOnce(githubRedirect("/repos/openclaw/renamed/issues/70007"))
      .mockResolvedValueOnce(publicRepository())
      .mockResolvedValueOnce(
        githubJson(
          previewPayload({
            repository_url: "https://api.github.com/repos/openclaw/renamed",
            user: { login: "octocat" },
          }),
        ),
      )
      .mockResolvedValueOnce(publicRepository());

    const preview = await loadPreview(
      previewTarget(70007, "issue", "old-name"),
      undefined,
      fetchMock,
    );

    expect(preview.login).toBe("octocat");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls.map(([input]) => requestUrl(input))).toEqual([
      "https://api.github.com/repos/openclaw/old-name",
      "https://api.github.com/repos/openclaw/old-name/issues/70007",
      "https://api.github.com/repos/openclaw/renamed",
      "https://api.github.com/repos/openclaw/renamed/issues/70007",
      "https://api.github.com/repos/openclaw/renamed",
    ]);
    for (const call of fetchMock.mock.calls) {
      expect(new URL(requestUrl(call[0])).origin).toBe("https://api.github.com");
      expect(new Headers(call[1]?.headers).get("Authorization")).toBe("Bearer github-test-token");
      expect(call[1]?.redirect).toBe("manual");
    }
  });

  it("re-checks visibility when the commits request is redirected into another repository", async () => {
    selectFixtureToken("github-test-token");
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

    const preview = await loadPreview(previewTarget(88201, "pull"), undefined, fetchMock);

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

  it("stops private repositories before fetching item metadata", async () => {
    selectFixtureToken("github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(githubJson({ private: true, visibility: "private" }));
    await expect(
      loadPreview(previewTarget(70010, "issue", "private"), undefined, fetchMock),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestUrl(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://api.github.com/repos/openclaw/private",
    );
  });

  it("does not expose metadata transferred into a private repository", async () => {
    selectFixtureToken("github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(publicRepository())
      .mockResolvedValueOnce(githubRedirect("/repos/openclaw/private/issues/70004"))
      .mockResolvedValueOnce(githubJson({ private: true }));

    await expect(
      loadPreview(previewTarget(70004, "issue", "public-source"), undefined, fetchMock),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer github-test-token",
    );
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer github-test-token",
    );
  });

  it.each(["issue", "pull"] as const)(
    "conditionally revalidates %s metadata and retires validators after an error",
    async (kind) => {
      let version = 1;
      let unavailable = false;
      const itemHeaders: (string | null)[] = [];
      const commitsHeaders: (string | null)[] = [];
      const fetchMock = previewFetch(async (url, init) => {
        if (url.endsWith("/repos/openclaw/openclaw")) {
          return publicRepository();
        }
        const commits = url.includes("/commits");
        const etag = `"${commits ? "commits" : "item"}-${version}"`;
        const validator = new Headers(init?.headers).get("If-None-Match");
        (commits ? commitsHeaders : itemHeaders).push(validator);
        if (unavailable) {
          return githubJson({}, 404);
        }
        if (validator === etag) {
          return new Response(null, { status: 304 });
        }
        const response = githubJson(
          commits
            ? [{ commit: { message: "No co-authors" } }]
            : previewPayload({ title: `Version ${version}`, user: { login: "octocat" } }),
        );
        response.headers.set("etag", etag);
        return response;
      });
      const target = previewTarget(940001, kind);
      const identity = managedIdentity(`conditional-${kind}`);
      const load = (refresh = false) => loadPreview(target, identity, fetchMock, refresh);
      const first = await load();
      const before = fetchMock.mock.calls.length;
      expect(await load()).toEqual(first);
      expect(fetchMock).toHaveBeenCalledTimes(before);
      expect(await load(true)).toEqual(first);
      version = 2;
      expect(await load(true)).toMatchObject({ title: "Version 2" });
      expect(await load(true)).toMatchObject({ title: "Version 2" });
      unavailable = true;
      await expect(load(true)).rejects.toMatchObject({ statusCode: 404 });
      unavailable = false;
      expect(await load(true)).toMatchObject({ title: "Version 2" });
      expect(itemHeaders).toEqual([null, '"item-1"', '"item-1"', '"item-2"', '"item-2"', null]);
      expect(commitsHeaders).toEqual(
        kind === "pull"
          ? [null, '"commits-1"', '"commits-1"', '"commits-2"', '"commits-2"', null]
          : [],
      );
    },
  );

  it("does not reuse representations across transports, token rotations, or anonymous fallback", async () => {
    const target = previewTarget(940002);
    const validators: (string | null)[] = [];
    let avatarReads = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      if (requestUrl(input).includes("avatars.githubusercontent.com")) {
        avatarReads += 1;
        return pngResponse();
      }
      if (requestUrl(input).endsWith("/repos/openclaw/openclaw")) {
        return publicRepository();
      }
      validators.push(new Headers(init?.headers).get("If-None-Match"));
      const response = itemResponse();
      response.headers.set("etag", '"item"');
      return response;
    });
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
    expect(validators).toEqual([null, null, null, null, null, null]);
    // Anonymous avatar bytes are shared; credentialed representations stay isolated.
    expect(avatarReads).toBe(2);
  });

  it.each(["private", "retired"])(
    "rejects %s access after a conditional item response",
    async (cause) => {
      let repositoryReads = 0;
      let avatarReads = 0;
      let retired = false;
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        if (requestUrl(input).includes("avatars.githubusercontent.com")) {
          avatarReads += 1;
          return pngResponse();
        }
        if (requestUrl(input).endsWith("/repos/openclaw/openclaw")) {
          if (++repositoryReads === 4) {
            retired = cause === "retired";
            return retired ? publicRepository() : githubJson({ private: true });
          }
          return publicRepository();
        }
        if (new Headers(init?.headers).has("If-None-Match")) {
          return new Response(null, { status: 304 });
        }
        const response = itemResponse();
        response.headers.set("etag", '"item"');
        return response;
      });
      const target = previewTarget(940003);
      const identity = managedIdentity("conditional-private", () => {
        if (retired) {
          throw new Error("identity retired");
        }
      });
      await loadPreview(target, identity, fetchMock);
      const refreshed = loadPreview(target, identity, fetchMock, true);
      if (cause === "retired") {
        await expect(refreshed).rejects.toThrow("identity retired");
      } else {
        await expect(refreshed).rejects.toMatchObject({ statusCode: 404 });
      }
      expect(avatarReads).toBe(1);
    },
  );

  it("does not let a failed older request replace an explicit refresh", async () => {
    const started = createDeferred<void>();
    const older = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (fetchMock.mock.calls.length === 1) {
        started.resolve();
        return older.promise;
      }
      return authorOnly({ title: "Refreshed preview" });
    });
    const fixtureTarget = previewTarget(70015, "issue", "refresh-order");
    const pending = loadPreview(fixtureTarget, undefined, fetchMock);
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 404 });
    await started.promise;
    await expect(loadPreview(fixtureTarget, undefined, fetchMock, true)).resolves.toMatchObject({
      title: "Refreshed preview",
    });
    const missingResponse = githubJson({}, 404);
    older.resolve(missingResponse);
    await rejected;
    expect(missingResponse.bodyUsed).toBe(true);
    await expect(loadPreview(fixtureTarget, undefined, fetchMock)).resolves.toMatchObject({
      title: "Refreshed preview",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

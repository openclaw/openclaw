import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlUiGitHubError, formatControlUiGitHubPreviewError } from "./github-api.js";
import {
  loadControlUiGitHubPreview as loadPluginPreview,
  parseControlUiGitHubPreviewTarget,
  type ControlUiGitHubPreviewIdentity,
} from "./preview.js";

// List endpoints such as /pulls/{n}/commits return arrays, not objects.
function githubJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function previewTarget(number: number, kind: "issue" | "pull" = "issue", repo = "openclaw") {
  return { kind, number, owner: "openclaw", repo };
}

function pngResponse() {
  return new Response(new Uint8Array([137, 80, 78, 71]), {
    headers: { "Content-Type": "image/png" },
  });
}

function publicRepository() {
  return githubJson({ private: false, visibility: "public" });
}

function githubRedirect(location: string) {
  return new Response(null, { status: 301, headers: { Location: location } });
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input?.url ?? "";
}

function previewPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    additions: 101,
    changed_files: 3,
    closed_at: "2026-07-04T09:53:52Z",
    created_at: "2026-07-04T05:03:47Z",
    deletions: 12,
    draft: false,
    merged_at: "2026-07-04T09:53:52Z",
    state: "closed",
    title: "fix(agents): derive conversation scope from trusted group facts",
    updated_at: "2026-07-04T09:53:55Z",
    base: { repo: { url: "https://api.github.com/repos/openclaw/openclaw" } },
    repository_url: "https://api.github.com/repos/openclaw/openclaw",
    user: {
      avatar_url: "https://avatars.githubusercontent.com/u/58493?v=4",
      login: "steipete",
    },
    ...overrides,
  };
}

function managedIdentity(cacheScope: string, assertSelected: () => void = vi.fn()) {
  return {
    token: `token-${cacheScope}`,
    cacheScope,
    assertSelected,
    revalidate: vi.fn(async () => assertSelected()),
  };
}

let fixtureIdentity: ControlUiGitHubPreviewIdentity | undefined;
function selectFixtureToken(token: string) {
  fixtureIdentity = { ...managedIdentity("fixture-" + token), token, optionalAuth: true };
}
function loadControlUiGitHubPreview(...args: Parameters<typeof loadPluginPreview>) {
  const [target, identity = fixtureIdentity, fetchImpl, refresh] = args;
  return loadPluginPreview(target, identity, fetchImpl, refresh);
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

  it.each(["repository", "body", "co-author avatar"])(
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
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = requestUrl(input);
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
              {
                once: true,
              },
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
          return githubJson([
            { commit: { message: "Co-authored-by: Ada <20+ada@users.noreply.github.com>" } },
          ]);
        }
        return currentStage === "item" ? githubJson(previewPayload()) : pngResponse();
      });
      const target = previewTarget(930307, "pull");
      const settled = vi.fn();
      const load = () =>
        loadControlUiGitHubPreview(target, identity, fetchMock).then(
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

  it("keeps selected identity caches separate and revalidates cached delivery", async () => {
    const fixtureTarget = previewTarget(88122);
    const firstIdentity = managedIdentity("first-preview-identity");
    const secondIdentity = managedIdentity("second-preview-identity");
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) =>
      requestUrl(input).includes("/issues/")
        ? githubJson(
            previewPayload({
              user: {
                login:
                  new Headers(init?.headers).get("Authorization") ===
                  `Bearer ${firstIdentity.token}`
                    ? "first-account"
                    : "second-account",
              },
            }),
          )
        : publicRepository(),
    );

    const first = await loadControlUiGitHubPreview(fixtureTarget, firstIdentity, fetchMock);
    const second = await loadControlUiGitHubPreview(fixtureTarget, secondIdentity, fetchMock);
    expect(first.login).toBe("first-account");
    expect(second.login).toBe("second-account");
    expect(fetchMock).toHaveBeenCalledTimes(6);

    secondIdentity.revalidate.mockRejectedValue(
      Object.assign(new Error("identity changed"), { reason: "changed" }),
    );
    await expect(
      loadControlUiGitHubPreview(fixtureTarget, secondIdentity, fetchMock),
    ).rejects.toMatchObject({ reason: "changed" });
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it.each([
    ["final visibility check", 3, false],
    ["repository redirect", 1, true],
    ["commits redirect", 4, true],
  ])(
    "blocks later GitHub dispatches after identity changes during %s",
    async (stage, stopAfter, redirect) => {
      let changed = false;
      const assertSelected = () => {
        if (changed) {
          throw Object.assign(new Error("identity changed"), { reason: "changed" });
        }
      };
      const identity = managedIdentity(`inflight-preview-identity-${stage}`, assertSelected);
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = requestUrl(input);
        if (fetchMock.mock.calls.length === stopAfter) {
          changed = true;
          if (redirect) {
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
        loadControlUiGitHubPreview(previewTarget(88123, "pull"), identity, fetchMock),
      ).rejects.toMatchObject({ reason: "changed" });
      expect(fetchMock).toHaveBeenCalledTimes(stopAfter);
    },
  );

  it("keeps concurrent readers and later cache hits independent of a disconnected caller", async () => {
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
    const first = loadControlUiGitHubPreview(fixtureTarget, identity, fetchMock);
    const rejected = expect(first).rejects.toMatchObject({ reason: "changed" });
    await started.promise;
    const second = loadControlUiGitHubPreview(fixtureTarget, follower, fetchMock);
    connected = false;
    repository.resolve(publicRepository());
    await rejected;
    await expect(second).resolves.toMatchObject({ login: "octocat" });
    const calls = fetchMock.mock.calls.length;
    await expect(
      loadControlUiGitHubPreview(fixtureTarget, follower, fetchMock),
    ).resolves.toMatchObject({
      login: "octocat",
    });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it("does not retry a selected identity authentication failure anonymously", async () => {
    const identity = managedIdentity("selected-preview-identity");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(githubJson({}, 401));
    await expect(
      loadControlUiGitHubPreview(previewTarget(88124), identity, fetchMock),
    ).rejects.toMatchObject({ statusCode: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves co-authors from noreply trailers without a lookup per person", async () => {
    const commits = [
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
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/commits")) {
        return githubJson(commits);
      }
      if (url.includes("avatars.githubusercontent.com")) {
        return pngResponse();
      }
      return githubJson(previewPayload());
    });

    const preview = await loadControlUiGitHubPreview(
      previewTarget(88101, "pull"),
      undefined,
      fetchMock,
    );

    expect(preview).toMatchObject({
      additions: 101,
      deletions: 12,
      changedFiles: 3,
      avatarDataUrl: "data:image/png;base64,iVBORw==",
      kind: "pull",
      login: "steipete",
      mergedAt: "2026-07-04T09:53:52Z",
      number: 88101,
      owner: "openclaw",
      repo: "openclaw",
    });
    expect(preview.coAuthorCount).toBe(4);
    expect(preview.coAuthors).toEqual([
      { login: "ada", avatarDataUrl: "data:image/png;base64,iVBORw==" },
      { login: "mira", avatarDataUrl: "data:image/png;base64,iVBORw==" },
      { login: "alan", avatarDataUrl: "data:image/png;base64,iVBORw==" },
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

    const preview = await loadControlUiGitHubPreview(
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
      .mockResolvedValueOnce(githubJson(previewPayload()))
      .mockResolvedValueOnce(avatarResponse);

    const preview = await loadControlUiGitHubPreview(
      previewTarget(70009, "issue", "bad-avatar"),
      undefined,
      fetchMock,
    );

    expect(preview.avatarDataUrl).toBeUndefined();
    expect(avatarResponse.bodyUsed).toBe(true);
  });

  it("retries stale optional authentication anonymously for public previews", async () => {
    selectFixtureToken("stale-github-token");
    let itemCalls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
      if (url.includes("/commits")) {
        return githubJson([]);
      }
      itemCalls += 1;
      return itemCalls === 1
        ? githubJson({ message: "Bad credentials" }, 401)
        : githubJson(previewPayload({ user: { login: "octocat" } }));
    });

    const preview = await loadControlUiGitHubPreview(
      previewTarget(70012, "pull"),
      undefined,
      fetchMock,
    );

    expect(preview.login).toBe("octocat");
    expect(itemCalls).toBe(2);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toHaveProperty(
      "Authorization",
      "Bearer stale-github-token",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
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

    const preview = await loadControlUiGitHubPreview(
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

  it("rejects cross-origin GitHub API redirects before forwarding credentials", async () => {
    selectFixtureToken("github-test-token");
    const redirectResponse = new Response("discard me", {
      status: 301,
      headers: { Location: "https://example.com/repos/openclaw/private" },
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(publicRepository())
      .mockResolvedValueOnce(redirectResponse);

    await expect(
      loadControlUiGitHubPreview(
        previewTarget(70008, "pull", "unsafe-redirect"),
        undefined,
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 502 } satisfies Partial<ControlUiGitHubError>);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new URL(requestUrl(fetchMock.mock.calls[1]?.[0])).origin).toBe("https://api.github.com");
    expect(redirectResponse.bodyUsed).toBe(true);
  });

  it("re-checks visibility when the commits request is redirected into another repository", async () => {
    selectFixtureToken("github-test-token");
    const visibilityChecks: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = requestUrl(input);
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
      return githubJson(previewPayload());
    });

    const preview = await loadControlUiGitHubPreview(
      previewTarget(88201, "pull"),
      undefined,
      fetchMock,
    );

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
      loadControlUiGitHubPreview(previewTarget(70010, "issue", "private"), undefined, fetchMock),
    ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<ControlUiGitHubError>);
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
      loadControlUiGitHubPreview(
        previewTarget(70004, "issue", "public-source"),
        undefined,
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<ControlUiGitHubError>);
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

  it("rechecks public visibility for every authenticated preview cache miss", async () => {
    selectFixtureToken("github-test-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(publicRepository())
      .mockResolvedValueOnce(
        githubJson(
          previewPayload({
            repository_url: "https://api.github.com/repos/openclaw/visibility-change",
            user: { login: "octocat" },
          }),
        ),
      )
      .mockResolvedValueOnce(publicRepository())
      .mockResolvedValueOnce(githubJson({ private: true }));

    await loadControlUiGitHubPreview(
      previewTarget(70005, "issue", "visibility-change"),
      undefined,
      fetchMock,
    );
    await expect(
      loadControlUiGitHubPreview(
        previewTarget(70006, "issue", "visibility-change"),
        undefined,
        fetchMock,
      ),
    ).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<ControlUiGitHubError>);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not let a failed older request replace an explicit refresh", async () => {
    const started = createDeferred<void>();
    const older = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      if (fetchMock.mock.calls.length === 1) {
        started.resolve();
        return older.promise;
      }
      return githubJson(previewPayload({ title: "Refreshed preview", user: { login: "octocat" } }));
    });
    const fixtureTarget = previewTarget(70015, "issue", "refresh-order");
    const pending = loadControlUiGitHubPreview(fixtureTarget, undefined, fetchMock);
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 404 });
    await started.promise;
    await expect(
      loadControlUiGitHubPreview(fixtureTarget, undefined, fetchMock, true),
    ).resolves.toMatchObject({ title: "Refreshed preview" });
    const missingResponse = githubJson({}, 404);
    older.resolve(missingResponse);
    await rejected;
    expect(missingResponse.bodyUsed).toBe(true);
    await expect(
      loadControlUiGitHubPreview(fixtureTarget, undefined, fetchMock),
    ).resolves.toMatchObject({
      title: "Refreshed preview",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

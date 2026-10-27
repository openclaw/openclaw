import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { formatControlUiGitHubPreviewError } from "./github-api.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import { loadControlUiGitHubPreview as loadPreview } from "./preview.js";
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
  queuedFetch as responses,
  requestUrl,
} from "./preview.test-support.js";

const optionalIdentity = (): ControlUiGitHubPreviewIdentity => ({
  ...managedIdentity("fixture-github-test-token"),
  token: "github-test-token",
  optionalAuth: true,
});
const itemResponse = (overrides: Record<string, unknown> = {}) =>
  githubJson(previewPayload(overrides));
const authorOnly = (overrides: Record<string, unknown> = {}) =>
  itemResponse({ user: { login: "octocat" }, ...overrides });
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
const avatarUrl = (id: number) => `https://avatars.githubusercontent.com/u/${id}?s=64`;
const urls = (fetchMock: ReturnType<typeof previewFetch>) =>
  fetchMock.mock.calls.map(([input]) => requestUrl(input));
function fixtureResponse(url: string, overrides = {}, commits = coauthorTrailers(["Ada", 20])) {
  return url.includes("avatars.githubusercontent.com")
    ? pngResponse()
    : url.endsWith("/repos/openclaw/openclaw")
      ? publicRepository()
      : url.includes("/commits")
        ? githubJson(commits)
        : itemResponse(overrides);
}
function mockDeadlineTimers(onCreate?: (controller: AbortController, ms: number) => void) {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    if (onCreate) {
      onCreate(controller, ms);
    } else {
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    }
    return controller.signal;
  });
}
afterEach(async () => {
  if (vi.isFakeTimers()) {
    await vi.runAllTimersAsync();
    vi.useRealTimers();
  }
  vi.restoreAllMocks();
});

it("keeps different commit revisions separate", async () => {
  const revisions = ["abcdef0", "b".repeat(40)];
  const fetchMock = responses(
    ...revisions.map((sha) =>
      githubJson({
        sha: sha.padEnd(40, "0"),
        commit: { message: `${sha}\n\nDetails`, author: { date: "2026-10-24T00:00:00Z" } },
      }),
    ),
  );
  for (const sha of revisions) {
    await expectPreview(
      loadPreview(
        { kind: "commit", owner: "openclaw", repo: "openclaw", sha },
        undefined,
        fetchMock,
      ),
      { sha, title: sha },
    );
  }
});

it.each([
  ["repository", /\/repos\/openclaw\/openclaw$/],
  ["body", /\/pulls\/930307$/],
  ["commits", /\/commits\?/],
  ["co-author avatar", /\/u\/20\?/],
] as const)("bounds slow %s reads by the preview deadline", async (stage, stalledUrl) => {
  // Native AbortSignal timers do not use Vitest's clock.
  mockDeadlineTimers();
  const identity = managedIdentity(`deadline-${stage}`);
  const fetchMock = previewFetch(async (url, init) => {
    const signal = init?.signal;
    if (!signal) {
      throw new Error("Expected cancellable GitHub transport");
    }
    if (stalledUrl.test(url)) {
      const aborted = new Promise<never>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      if (stage === "body") {
        return new Response(
          new ReadableStream({
            start(controller) {
              void aborted.catch((reason: unknown) => controller.error(reason));
            },
          }),
        );
      }
      return aborted;
    }
    // Metadata/commits consume budget before a later slow request starts.
    await delay(200);
    return fixtureResponse(url);
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
});

it.each(["repository redirect", "commits redirect"])(
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
        (stage === "commits redirect" && url.includes("/commits"))
      ) {
        changed = true;
        return githubRedirect(url.replace("/openclaw/openclaw", "/openclaw/renamed"));
      }
      return fixtureResponse(url, { user: { login: "octocat" } }, []);
    });
    await expect(
      loadPreview(previewTarget(88123, "pull"), identity, fetchMock),
    ).rejects.toMatchObject({ reason: "changed" });
    expect(changed).toBe(true);
    expect(dispatchesAfterChange).toEqual([]);
  },
);

it("overlaps pull reads but denies delivery when visibility changes", async () => {
  vi.useFakeTimers();
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
    if (url.endsWith("/repos/openclaw/openclaw")) {
      repositoryReads += 1;
      if (repositoryReads > 1) {
        return githubJson({ private: true, visibility: "private" });
      }
    }
    return fixtureResponse(url);
  });
  const settled = vi.fn();
  const pending = loadPreview(
    previewTarget(88128, "pull"),
    managedIdentity("overlap-private"),
    fetchMock,
  ).then(
    (preview) => settled({ preview }),
    (error: unknown) => settled({ error }),
  );
  await vi.advanceTimersByTimeAsync(100);
  // Admission completed; item and commits must both start before either response resolves.
  expect(started).toEqual(["other", "item", "commits"]);
  await vi.advanceTimersByTimeAsync(199);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toHaveBeenCalledExactlyOnceWith({
    error: expect.objectContaining({ statusCode: 404 }),
  });
  await pending;
});

it("evicts a disconnected caller's failed cold load for the next request", async () => {
  let connected = true;
  const identity = managedIdentity("shared-preview-identity", () => {
    if (!connected) {
      throw Object.assign(new Error("identity changed"), { reason: "changed" });
    }
  });
  const follower = managedIdentity("shared-preview-identity");
  const started = createDeferred<void>();
  const response = createDeferred<Response>();
  const fetchMock = previewFetch((url) => {
    if (fetchMock.mock.calls.length === 1) {
      started.resolve();
      return response.promise;
    }
    return url.includes("/issues/") ? authorOnly() : publicRepository();
  });
  const fixtureTarget = previewTarget(88125);
  const first = loadPreview(fixtureTarget, identity, fetchMock);
  const rejected = expect(first).rejects.toMatchObject({ reason: "changed" });
  await started.promise;
  const second = loadPreview(fixtureTarget, follower, fetchMock);
  const secondRejected = expect(second).rejects.toMatchObject({ reason: "changed" });
  connected = false;
  response.resolve(publicRepository());
  await rejected;
  await secondRejected;
  await expectPreview(loadPreview(fixtureTarget, follower, fetchMock), { login: "octocat" });
});

it("does not retry a selected identity authentication failure anonymously", async () => {
  const identity = managedIdentity("selected-preview-identity");
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(githubJson({}, 401));
  await expectStatus(loadPreview(previewTarget(88124), identity, fetchMock), 401);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("resolves co-authors from noreply trailers without a lookup per person", async () => {
  const messages = [
    `${"x".repeat(300 * 1024)}\n\nCo-authored-by:\t Ada King \t<20+ada@users.noreply.github.com>\t`,
    ...["\n", "\r", "\u2028", "\u2029"].map(
      (separator, index) =>
        `Co-authored-by: Invalid${separator}continued <${80 + index}+invalid-${index}@users.noreply.github.com>`,
    ),
    "fix: two\n\nCo-authored-by: ada <20+ADA@users.noreply.github.com>",
    "Co-authored-by: Someone <someone@example.com>",
  ].map((message) => ({ commit: { message } }));
  messages.push(...coauthorTrailers(["Mira", 7], ["steipete", 58493], ["Alan", 31], ["Grace", 99]));
  const fetchMock = previewFetch((url) => fixtureResponse(url, {}, messages));

  const preview = await loadPreview(previewTarget(88101, "pull"), undefined, fetchMock);

  expect(preview.avatarDataUrl).toBe(avatarDataUrl);
  expect(preview.coAuthorCount).toBe(4);
  expect(preview.coAuthors).toEqual(
    ["ada", "mira", "alan"].map((login) => ({ login, avatarDataUrl })),
  );
  expect(urls(fetchMock).filter((url) => url.startsWith("https://api.github.com/"))).toHaveLength(
    2,
  );
  expect(
    urls(fetchMock).filter((url) => url.startsWith("https://avatars.githubusercontent.com/")),
  ).toEqual([58493, 20, 7, 31].map(avatarUrl));
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

it.each(["private", "transferred", "renamed"])(
  "admits only public %s repositories",
  async (mode) => {
    const moved = mode !== "private";
    const allowed = mode === "renamed";
    const destination = "https://api.github.com/repos/openclaw/renamed";
    const privateRepo = githubJson({ private: true, visibility: "private" });
    const fetchMock = responses(
      ...(moved ? [publicRepository(), githubRedirect(destination + "/issues/70007")] : []),
      allowed ? publicRepository() : privateRepo,
      ...(allowed ? [authorOnly({ repository_url: destination }), publicRepository()] : []),
    );
    const pending = loadPreview(previewTarget(70007), optionalIdentity(), fetchMock);
    if (allowed) {
      await expectPreview(pending, { login: "octocat" });
    } else {
      await expectStatus(pending, 404);
    }
    expect(fetchMock).toHaveBeenCalledTimes(allowed ? 5 : moved ? 3 : 1);
    for (const [, init] of fetchMock.mock.calls) {
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer github-test-token");
      expect(init?.redirect).toBe("manual");
    }
  },
);

it("re-checks visibility when the commits request is redirected into another repository", async () => {
  const identity = optionalIdentity();
  const fetchMock = previewFetch(async (url) => {
    if (url.endsWith("/repos/openclaw/openclaw")) {
      return publicRepository();
    }
    if (url.endsWith("/repos/openclaw/secret")) {
      // The token can read it; the Control UI viewer must not.
      return githubJson({ private: true });
    }
    if (url.includes("/commits")) {
      return githubRedirect("https://api.github.com/repos/openclaw/secret/pulls/88201/commits");
    }
    return fixtureResponse(url);
  });

  const preview = await loadPreview(previewTarget(88201, "pull"), identity, fetchMock);

  expect(preview.login).toBe("steipete");
  expect(preview.coAuthors).toBeUndefined();
  expect(urls(fetchMock)).toContain("https://api.github.com/repos/openclaw/secret");
  expect(urls(fetchMock).filter((url) => url.includes("/secret/pulls"))).toHaveLength(0);
});

it("revalidates metadata, refreshes decoration, and retires failed representations", async () => {
  vi.useFakeTimers();
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = conditionalPreviewFixture("pull", 940001, { authors: [["Ada", 20]] });
  const { state, avatars, refreshed, load } = f;
  const first = await load(false);
  expect(avatars).toEqual([58493, 20].map(avatarUrl));
  now += 299_999;
  expect(await load()).toEqual(first);
  expect(avatars).toHaveLength(2);
  now += 1;
  state.avatar = 2;
  const delivered = vi.fn();
  const readers = Promise.all([load(), load()]).then(delivered);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toHaveBeenCalledExactlyOnceWith([first, first]);
    expect(avatars).toHaveLength(4);
  } finally {
    refreshed.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await readers;
  }
  expect(await load()).toEqual({
    ...first,
    avatarDataUrl: "data:image/png;base64,Ag==",
    coAuthors: [{ login: "ada", avatarDataUrl: "data:image/png;base64,Ag==" }],
  });
  state.item = 3;
  state.login = "ada";
  const changed = await load();
  expect(changed).toMatchObject({ login: "ada", title: "Version 3" });
  expect([changed.coAuthors, changed.coAuthorCount]).toEqual([undefined, undefined]);
  expect(avatars).toHaveLength(4);
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
    await expect(refreshed).rejects.toMatchObject(
      cause === "retired" ? { message: "identity retired" } : { statusCode: 404 },
    );
    expect(f.avatars).toHaveLength(1);
  },
);
it("isolates representations by transport and credentials while sharing anonymous avatars", async () => {
  vi.useFakeTimers();
  const avatarHeaders: (string | null)[] = [];
  const itemHeaders: (string | null)[] = [];
  let rejectAuth = false;
  const transport = previewFetch((url, init) => {
    const headers = new Headers(init?.headers);
    const authorization = headers.get("Authorization");
    if (url.includes("avatars.githubusercontent.com")) {
      avatarHeaders.push(authorization);
      return pngResponse();
    }
    if (rejectAuth && authorization) {
      return githubJson({}, 401);
    }
    if (url.endsWith("/repos/openclaw/openclaw")) {
      return publicRepository();
    }
    itemHeaders.push(headers.get("If-None-Match"));
    return githubJson(previewPayload({ title: authorization ?? "anonymous" }), 200, {
      etag: '"item"',
    });
  });
  const identity: ControlUiGitHubPreviewIdentity = {
    ...managedIdentity("first"),
    optionalAuth: true,
  };
  const read = (
    selected = identity,
    fetcher: typeof fetch = transport,
    number = 1,
    refresh = false,
  ) => loadPreview(previewTarget(number), selected, fetcher, refresh);
  const previews = await Promise.all([read(), read(managedIdentity("second"), transport, 2)]);
  expect(previews.map(({ title }) => title)).toEqual(["Bearer token-first", "Bearer token-second"]);
  expect(previews.every((preview) => preview.avatarDataUrl === avatarDataUrl)).toBe(true);
  expect(avatarHeaders).toEqual([null]);
  await read({ ...identity, token: "rotated-fixture-token" });
  const secondTransport: typeof fetch = (input, init) => transport(input, init);
  await read(identity, secondTransport);
  await read({ ...identity, cacheScope: "another-reader-scope" });
  rejectAuth = true;
  await read(identity, transport, 1, true);
  rejectAuth = false;
  await read(identity, transport, 1, true);
  // Reader scopes share a representation only under the same transport and credential.
  expect(itemHeaders).toEqual([null, null, null, null, '"item"', null, '"item"']);
  expect(avatarHeaders).toEqual([null, null]);
  const first = await read();
  identity.revalidate = vi.fn(async () => {
    await delay(750);
  });
  const delivered = vi.fn();
  const cached = read().then(delivered);
  await vi.advanceTimersByTimeAsync(750);
  expect(delivered).toHaveBeenCalledExactlyOnceWith(first);
  await cached;
  identity.revalidate = vi.fn().mockRejectedValue(new Error("identity retired"));
  await expect(read()).rejects.toThrow("identity retired");
});

it.each(["older", "newer"] as const)(
  "keeps %s-initiated avatar deadlines independent",
  async (initiator) => {
    const deadlines: AbortController[] = [];
    mockDeadlineTimers((controller, ms) => {
      if (ms === 2_000) {
        deadlines.push(controller);
      }
    });
    const metadata = createDeferred<Response>();
    const avatar = createDeferred<Response>();
    const avatarStarted = createDeferred<void>();
    let avatarReads = 0;
    let avatarSignal: AbortSignal | null | undefined;
    const fetchMock = previewFetch(async (url, init) => {
      if (url.includes("avatars.githubusercontent.com")) {
        avatarReads += 1;
        avatarSignal = init?.signal;
        avatarStarted.resolve();
        return avatar.promise;
      }
      return url.endsWith(`/issues/${initiator === "older" ? 2 : 1}`)
        ? metadata.promise
        : githubJson(previewPayload());
    });
    const older = loadPreview(previewTarget(1), undefined, fetchMock);
    const newer = loadPreview(previewTarget(2), undefined, fetchMock);
    try {
      await avatarStarted.promise;
      metadata.resolve(githubJson(previewPayload()));
      await vi.advanceTimersByTimeAsync(0);
      deadlines[0]!.abort(new DOMException("Timed out", "TimeoutError"));
      const expired = await older;
      expect(expired.login).toBe("steipete");
      expect(expired.avatarDataUrl).toBeUndefined();
      expect(deadlines[1]!.signal.aborted).toBe(false);
      expect(avatarSignal).toHaveProperty("aborted", false);
      avatar.resolve(pngResponse());
      expect((await newer).avatarDataUrl).toBe(avatarDataUrl);
      expect(avatarReads).toBe(1);
    } finally {
      metadata.resolve(githubJson(previewPayload()));
      avatar.resolve(pngResponse());
      await Promise.all([older, newer]);
    }
  },
);

it("discards failed avatar bodies and retries uncached failures", async () => {
  let avatarReads = 0;
  const rejected = [
    new Response("unavailable", { status: 503 }),
    new Response("not an image", {
      headers: { "Content-Type": "text/plain" },
    }),
  ];
  const fetchMock = previewFetch((url) =>
    url.includes("avatars.githubusercontent.com")
      ? (rejected[avatarReads++] ?? pngResponse())
      : itemResponse(),
  );
  const load = () => loadPreview(previewTarget(1), undefined, fetchMock, true);
  for (const response of rejected) {
    expect((await load()).avatarDataUrl).toBeUndefined();
    expect(response.bodyUsed).toBe(true);
  }
  expect((await load()).avatarDataUrl).toBe(avatarDataUrl);
  expect(avatarReads).toBe(3);
  await load();
  expect(avatarReads).toBe(3);
});

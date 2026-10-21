import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadControlUiGitHubPreview as loadPreview } from "./preview.js";
import {
  avatarDataUrl,
  conditionalPreviewFixture,
  githubJson,
  managedIdentity,
  pngResponse,
  previewPayload,
  previewFetch,
  previewTarget,
  requestUrl,
} from "./preview.test-support.js";

describe("GitHub preview decoration cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("shares anonymous avatars across distinct previews while keeping metadata credential-scoped", async () => {
    let avatarReads = 0;
    const avatarHeaders: (string | undefined)[] = [];
    await withServer(
      (request, response) => {
        if (request.url?.startsWith("/u/")) {
          avatarReads += 1;
          avatarHeaders.push(request.headers.authorization);
          response.writeHead(200, { "Content-Type": "image/png" });
          response.end(new Uint8Array([137, 80, 78, 71]));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify(
            request.url?.includes("/issues/")
              ? previewPayload({ title: request.headers.authorization })
              : { private: false, visibility: "public" },
          ),
        );
      },
      async (baseUrl) => {
        const transport: typeof fetch = (input, init) => {
          const url = new URL(requestUrl(input));
          return fetch(`${baseUrl}${url.pathname}${url.search}`, init);
        };
        const identities = [managedIdentity("first"), managedIdentity("second")];
        const previews = await Promise.all(
          [1, 2].map((number) =>
            loadPreview(previewTarget(number), identities[number % 2], transport),
          ),
        );
        expect(previews.map((preview) => preview.title)).toEqual([
          "Bearer token-second",
          "Bearer token-first",
        ]);
        expect(previews.every((preview) => preview.avatarDataUrl === avatarDataUrl)).toBe(true);
        expect(avatarReads).toBe(1);
        expect(avatarHeaders).toEqual([undefined]);
        await loadPreview(previewTarget(5), identities[0], transport);
        expect(avatarReads).toBe(1);
      },
    );
  });

  it.each(["older", "newer"] as const)(
    "keeps independent deadlines when the %s preview starts a shared avatar fetch",
    async (initiator) => {
      vi.useFakeTimers();
      const deadlines: AbortController[] = [];
      vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
        const controller = new AbortController();
        if (ms === 2_000) {
          deadlines.push(controller);
        }
        return controller.signal;
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
      const settled = vi.fn();
      const older = loadPreview(previewTarget(1), undefined, fetchMock).then(settled);
      const newer = loadPreview(previewTarget(2), undefined, fetchMock);
      try {
        await avatarStarted.promise;
        metadata.resolve(githubJson(previewPayload()));
        await vi.advanceTimersByTimeAsync(0);
        deadlines[0]!.abort(new DOMException("Timed out", "TimeoutError"));
        await vi.advanceTimersByTimeAsync(0);
        expect(settled).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ login: "steipete" }),
        );
        expect(settled.mock.calls[0]?.[0].avatarDataUrl).toBeUndefined();
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

  it("retries failed avatars and evicts the oldest of 200 retained images", async () => {
    let avatarReads = 0;
    const fetchMock = previewFetch(async (rawUrl) => {
      const url = new URL(rawUrl);
      if (url.hostname === "avatars.githubusercontent.com") {
        return ++avatarReads === 1 ? new Response(null, { status: 503 }) : pngResponse();
      }
      const id = url.pathname.split("/").at(-1);
      return githubJson(
        previewPayload({
          user: { login: "octocat", avatar_url: `https://avatars.githubusercontent.com/u/${id}` },
        }),
      );
    });
    const load = (number: number) => loadPreview(previewTarget(number), undefined, fetchMock, true);
    expect((await load(1)).avatarDataUrl).toBeUndefined();
    expect((await load(1)).avatarDataUrl).toBe(avatarDataUrl);
    expect(avatarReads).toBe(2);
    for (let number = 2; number <= 201; number += 1) {
      await load(number);
    }
    expect(avatarReads).toBe(202);
    await load(201);
    expect(avatarReads).toBe(202);
    await load(1);
    expect(avatarReads).toBe(203);
  });

  it.each(["issue", "pull"] as const)(
    "refreshes expired %s decoration without blocking readers or extending its age",
    async (kind) => {
      vi.useFakeTimers();
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const f = conditionalPreviewFixture(kind, 940005, {
        authors: [
          ["Ada", 20],
          ["Mira", 7],
          ["Alan", 31],
          ["Grace", 99],
        ],
      });
      const { state, avatars, refreshed, load } = f;
      const first = await load();
      const coldReads = kind === "pull" ? 4 : 1;
      expect(avatars).toHaveLength(coldReads);
      if (kind === "pull") {
        expect(first.coAuthorCount).toBe(4);
        expect(first.coAuthors?.map((author) => author.login)).toEqual(["ada", "mira", "alan"]);
      }
      for (const elapsed of [60_000, 60_000, 179_999]) {
        now += elapsed;
        expect(await load()).toEqual(first);
        expect(avatars).toHaveLength(coldReads);
      }
      now += 1;
      state.avatar = 2;
      const delivered = vi.fn();
      const readers = Promise.all([load(), load()]).then(delivered);
      try {
        await vi.advanceTimersByTimeAsync(0);
        expect(delivered).toHaveBeenCalledExactlyOnceWith([first, first]);
        expect(avatars).toHaveLength(2 * coldReads);
      } finally {
        refreshed.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await readers;
      }
      expect(await load()).toEqual({
        ...first,
        avatarDataUrl: "data:image/png;base64,Ag==",
        ...(kind === "pull"
          ? {
              coAuthors: ["ada", "mira", "alan"].map((login) => ({
                login,
                avatarDataUrl: "data:image/png;base64,Ag==",
              })),
            }
          : {}),
      });
      expect(avatars).toHaveLength(2 * coldReads);
      expect(f.itemHeaders.length + f.commitsHeaders.length).toBe(kind === "pull" ? 14 : 7);
    },
  );

  it("reuses avatars across metadata changes and excludes a changed author", async () => {
    const { state, avatars, load } = conditionalPreviewFixture("pull", 940006, {
      authors: [["Ada", 20]],
    });
    const first = await load();
    expect(avatars.splice(0)).toEqual([
      "https://avatars.githubusercontent.com/u/58493?s=64",
      "https://avatars.githubusercontent.com/u/20?s=64",
    ]);
    state.item += 1;
    expect(await load()).toEqual({ ...first, title: "Version 2" });
    expect(avatars.splice(0)).toEqual([]);
    state.commits += 1;
    expect(await load()).toEqual({ ...first, title: "Version 2" });
    expect(avatars.splice(0)).toEqual([]);
    state.item += 1;
    state.login = "ada";
    const changedAuthor = await load();
    expect(changedAuthor).toMatchObject({ login: "ada", title: "Version 3" });
    expect([changedAuthor.coAuthors, changedAuthor.coAuthorCount]).toEqual([undefined, undefined]);
    expect(avatars).toEqual([]);
  });
});

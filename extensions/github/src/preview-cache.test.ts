import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadControlUiGitHubPreview } from "./preview.js";
import {
  githubJson,
  managedIdentity,
  pngResponse,
  previewPayload,
  previewTarget,
  publicRepository,
  requestUrl,
} from "./preview.test-support.js";

describe("GitHub preview decoration cache", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
          [1, 2, 3, 4].map((number) =>
            loadControlUiGitHubPreview(previewTarget(number), identities[number % 2], transport),
          ),
        );
        expect(previews.map((preview) => preview.title)).toEqual([
          "Bearer token-second",
          "Bearer token-first",
          "Bearer token-second",
          "Bearer token-first",
        ]);
        expect(
          previews.every((preview) => preview.avatarDataUrl === "data:image/png;base64,iVBORw=="),
        ).toBe(true);
        expect(avatarReads).toBe(1);
        expect(avatarHeaders).toEqual([undefined]);
        await loadControlUiGitHubPreview(previewTarget(5), identities[0], transport);
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
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = requestUrl(input);
        if (url.includes("avatars.githubusercontent.com")) {
          avatarReads += 1;
          avatarStarted.resolve();
          const signal = init?.signal;
          return new Promise<Response>((resolve, reject) => {
            const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
            signal?.addEventListener("abort", onAbort, { once: true });
            void avatar.promise.then((response) => {
              signal?.removeEventListener("abort", onAbort);
              resolve(response);
            });
          });
        }
        return url.endsWith(`/issues/${initiator === "older" ? 2 : 1}`)
          ? metadata.promise
          : githubJson(previewPayload());
      });
      const settled = vi.fn();
      const older = loadControlUiGitHubPreview(previewTarget(1), undefined, fetchMock).then(
        settled,
      );
      const newer = loadControlUiGitHubPreview(previewTarget(2), undefined, fetchMock);
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
        avatar.resolve(pngResponse());
        expect((await newer).avatarDataUrl).toBe("data:image/png;base64,iVBORw==");
        expect(avatarReads).toBe(1);
      } finally {
        metadata.resolve(githubJson(previewPayload()));
        avatar.resolve(pngResponse());
        await Promise.all([older, newer]);
        vi.useRealTimers();
      }
    },
  );

  it("retries failed avatars and evicts the oldest of 200 retained images", async () => {
    let avatarReads = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = new URL(requestUrl(input));
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
    const load = (number: number) =>
      loadControlUiGitHubPreview(previewTarget(number), undefined, fetchMock, true);
    expect((await load(1)).avatarDataUrl).toBeUndefined();
    expect((await load(1)).avatarDataUrl).toBe("data:image/png;base64,iVBORw==");
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
    "reuses unchanged %s decoration without extending its five-minute age",
    async (kind) => {
      let now = Date.now();
      vi.spyOn(Date, "now").mockImplementation(() => now);
      let avatarReads = 0;
      let avatarVersion = 1;
      let metadataReads = 0;
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
        const url = requestUrl(input);
        if (url.includes("avatars.githubusercontent.com")) {
          avatarReads += 1;
          return new Response(new Uint8Array([avatarVersion]), {
            headers: { "Content-Type": "image/png" },
          });
        }
        if (url.endsWith("/repos/openclaw/openclaw")) {
          return publicRepository();
        }
        metadataReads += 1;
        if (new Headers(init?.headers).has("If-None-Match")) {
          return new Response(null, { status: 304 });
        }
        const response = githubJson(
          url.includes("/commits")
            ? [
                {
                  commit: {
                    message: [
                      "Co-authored-by: Ada <20+ada@users.noreply.github.com>",
                      "Co-authored-by: Mira <7+mira@users.noreply.github.com>",
                      "Co-authored-by: Alan <31+alan@users.noreply.github.com>",
                      "Co-authored-by: Grace <99+grace@users.noreply.github.com>",
                    ].join("\n"),
                  },
                },
              ]
            : previewPayload(),
        );
        response.headers.set("etag", url.includes("/commits") ? '"commits"' : '"item"');
        return response;
      });
      const target = previewTarget(940005, kind);
      const identity = managedIdentity(`decoration-age-${kind}`);
      const load = () => loadControlUiGitHubPreview(target, identity, fetchMock, true);
      const first = await load();
      const coldReads = kind === "pull" ? 4 : 1;
      expect(avatarReads).toBe(coldReads);
      if (kind === "pull") {
        expect(first.coAuthorCount).toBe(4);
        expect(first.coAuthors?.map((author) => author.login)).toEqual(["ada", "mira", "alan"]);
      }
      for (const elapsed of [60_000, 60_000, 179_999]) {
        now += elapsed;
        expect(await load()).toEqual(first);
        expect(avatarReads).toBe(coldReads);
      }
      now += 1;
      avatarVersion = 2;
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
      expect(avatarReads).toBe(2 * coldReads);
      expect(metadataReads).toBe(kind === "pull" ? 10 : 5);
    },
  );

  it("reuses avatars across metadata changes and excludes a changed author", async () => {
    let itemVersion = 1;
    let commitsVersion = 1;
    let login = "steipete";
    const avatarUrls: string[] = [];
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url.includes("avatars.githubusercontent.com")) {
        avatarUrls.push(url);
        return pngResponse();
      }
      if (url.endsWith("/repos/openclaw/openclaw")) {
        return publicRepository();
      }
      const isCommits = url.includes("/commits");
      const etag = `"${isCommits ? "commits" : "item"}-${isCommits ? commitsVersion : itemVersion}"`;
      if (new Headers(init?.headers).get("If-None-Match") === etag) {
        return new Response(null, { status: 304 });
      }
      const response = githubJson(
        isCommits
          ? [{ commit: { message: "Co-authored-by: Ada <20+ada@users.noreply.github.com>" } }]
          : previewPayload({
              title: `Version ${itemVersion}`,
              user: { login, avatar_url: "https://avatars.githubusercontent.com/u/58493" },
            }),
      );
      response.headers.set("etag", etag);
      return response;
    });
    const target = previewTarget(940006, "pull");
    const identity = managedIdentity("independent-decoration");
    const load = () => loadControlUiGitHubPreview(target, identity, fetchMock, true);
    const first = await load();
    expect(avatarUrls.splice(0)).toEqual([
      "https://avatars.githubusercontent.com/u/58493?s=64",
      "https://avatars.githubusercontent.com/u/20?s=64",
    ]);
    itemVersion += 1;
    expect(await load()).toEqual({ ...first, title: "Version 2" });
    expect(avatarUrls.splice(0)).toEqual([]);
    commitsVersion += 1;
    expect(await load()).toEqual({ ...first, title: "Version 2" });
    expect(avatarUrls.splice(0)).toEqual([]);
    itemVersion += 1;
    login = "ada";
    const changedAuthor = await load();
    expect(changedAuthor).toMatchObject({ login: "ada", title: "Version 3" });
    expect(changedAuthor.coAuthors).toBeUndefined();
    expect(changedAuthor.coAuthorCount).toBeUndefined();
    expect(avatarUrls).toEqual([]);
  });
});

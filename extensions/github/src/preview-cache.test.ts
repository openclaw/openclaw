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

  it("refreshes item and commit decoration independently and excludes a changed author", async () => {
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
    expect(avatarUrls.splice(0)).toEqual(["https://avatars.githubusercontent.com/u/58493?s=64"]);
    commitsVersion += 1;
    expect(await load()).toEqual({ ...first, title: "Version 2" });
    expect(avatarUrls.splice(0)).toEqual(["https://avatars.githubusercontent.com/u/20?s=64"]);
    itemVersion += 1;
    login = "ada";
    const changedAuthor = await load();
    expect(changedAuthor).toMatchObject({ login: "ada", title: "Version 3" });
    expect(changedAuthor.coAuthors).toBeUndefined();
    expect(changedAuthor.coAuthorCount).toBeUndefined();
    expect(avatarUrls).toEqual(["https://avatars.githubusercontent.com/u/58493?s=64"]);
  });
});

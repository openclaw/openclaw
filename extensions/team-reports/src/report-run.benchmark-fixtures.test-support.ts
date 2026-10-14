import { setImmediate } from "node:timers/promises";
import type { SourceRuntime } from "./types.js";

export const fixtureDay = "2026-09-25";
const sinceMs = Date.parse(`${fixtureDay}T00:00:00Z`);
const epochMs = 1420070400000n;
export const fixturePeople = Array.from({ length: 20 }, (_, index) => ({
  github: [`person-${index}`],
  discordUserId: String(3000 + index),
}));
export const fixtureChannels = Array.from({ length: 12 }, (_, index) => ({
  id: String(2000 + index),
  excerpts: true,
}));
const atMs = (index: number) => sinceMs + 1000 + index * 30_000;
const repoName = (index: number) => `fixture/repo-${index % 93}`;
const login = (index: number) => fixturePeople[index % fixturePeople.length].github[0];
const snowflake = (index: number) => ((BigInt(atMs(index)) - epochMs) << 22n).toString();

/** Synthetic wire responses are generated per page, never retained as an input corpus. */
export function createReportRunFixtureFetch(): NonNullable<SourceRuntime["fetchImpl"]> {
  return async (input) => {
    // Every response arrives on a fresh event-loop turn, as real network I/O does.
    await setImmediate();
    const url = new URL(input);
    const path = url.pathname.replace(/^\/api\/v10/, "");
    const page = Number(url.searchParams.get("page") ?? 1);
    const response = (data: unknown, hasNext = false) => {
      const next = new URL(url);
      next.searchParams.set("page", String(page + 1));
      return new Response(JSON.stringify(data), {
        headers: hasNext ? { link: `<${next.href}>; rel="next"` } : undefined,
      });
    };
    if (path === "/orgs/fixture/repos") {
      return response(
        Array.from({ length: 93 }, (_, index) => ({
          full_name: repoName(index),
          archived: false,
          pushed_at: new Date(atMs(0)).toISOString(),
        })),
      );
    }
    if (path === "/search/issues" || path === "/search/commits") {
      const query = url.searchParams.get("q") ?? "";
      const range = /(?:created|updated|closed|merged|committer-date):([^ ]+)\.\.([^ ]+)/.exec(
        query,
      );
      if (!range) {
        throw new Error(`Missing fixture search range: ${query}`);
      }
      const commits = path.endsWith("commits");
      const eligible =
        commits || (query.includes("is:issue ") && / (?:created|updated):/.test(query));
      const firstMs = Date.parse(range[1]);
      const lastMs = Date.parse(range[2]);
      const indexes = eligible
        ? Array.from({ length: commits ? 1000 : 2000 }, (_, index) => index).filter(
            (index) => atMs(index) >= firstMs && atMs(index) <= lastMs,
          )
        : [];
      const items = indexes.slice((page - 1) * 100, page * 100).map((index) =>
        commits
          ? {
              sha: index.toString(16).padStart(40, "0"),
              html_url: `https://github.com/${repoName(index)}/commit/${index}`,
              author: { login: login(index) },
              repository: { full_name: repoName(index) },
              commit: {
                message: `Improve fixture workflow ${index}\n\n${"Synthetic commit details. ".repeat(40)}`,
                committer: { date: new Date(atMs(index)).toISOString() },
              },
            }
          : {
              number: index + 1,
              title: `Resolve fixture issue ${index}: preserve source attribution and activity counts`,
              html_url: `https://github.com/${repoName(index)}/issues/${index + 1}`,
              repository_url: `https://api.github.com/repos/${repoName(index)}`,
              user: { login: login(index) },
              created_at: new Date(atMs(index)).toISOString(),
              closed_at: null,
              body: `Synthetic issue ${index}. ${"Reproduction details and expected behavior. ".repeat(100)}`,
            },
      );
      return response(
        { total_count: indexes.length, incomplete_results: false, items },
        page * 100 < indexes.length,
      );
    }
    if (
      /^\/repos\/fixture\/repo-\d+\/(?:issues\/comments|pulls\/comments|security-advisories)$/.test(
        path,
      )
    ) {
      return response([]);
    }
    if (path === "/guilds/1000/channels") {
      return response(
        fixtureChannels.map(({ id }, index) => ({ id, name: `channel-${index}`, type: 0 })),
      );
    }
    if (path === "/guilds/1000/threads/active") {
      return response({
        threads: Array.from({ length: 692 }, (_, index) => ({
          id: String(4000 + index),
          parent_id: fixtureChannels[index % fixtureChannels.length].id,
          name: `thread-${index}`,
          type: 11,
        })),
      });
    }
    if (/\/threads\/archived\/(public|private)$/.test(path)) {
      return response({ threads: [], has_more: false });
    }
    const messages = /^\/channels\/(\d+)\/messages$/.exec(path);
    if (messages) {
      const id = Number(messages[1]);
      const channel = id >= 2000 && id < 2012;
      const count = channel ? 104 : id < 4252 ? 1 : 0;
      const offset = channel ? (id - 2000) * 104 : 1248 + id - 4000;
      const after = BigInt(url.searchParams.get("after") ?? "0");
      const selected = Array.from({ length: count }, (_, index) => offset + index)
        .filter((index) => BigInt(snowflake(index)) > after)
        .slice(0, 100)
        .toReversed();
      return response(
        selected.map((index) => ({
          id: snowflake(index),
          author: { id: fixturePeople[index % fixturePeople.length].discordUserId, bot: false },
          content: `Fixture discussion ${index}. ${"Review the change and preserve expected behavior. ".repeat(20)}`,
        })),
      );
    }
    throw new Error(`Unexpected fixture API request: ${url.href}`);
  };
}

// The benchmark worker replaces only the HTTP boundary; parsers and collection remain real.
const fixtureFetch = createReportRunFixtureFetch();
export async function fetchWithSsrFGuard(params: { url: string; init?: RequestInit }) {
  return { response: await fixtureFetch(params.url, params.init), release: async () => {} };
}

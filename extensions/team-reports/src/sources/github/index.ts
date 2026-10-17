import { z } from "zod";
import { truncateGraphemes } from "../../text.js";
import type {
  ActivityEntry,
  ActivityWindow,
  GithubItem,
  GithubSource,
  GithubSourceConfig,
  Person,
  Roster,
  SourceRuntime,
  SourceStatus,
} from "../../types.js";
import { checkAbort } from "../http.js";
import {
  ABORT_LABEL,
  GithubClient,
  GithubHttpError,
  GithubSourceError,
  parse,
  pathWithQuery,
} from "./client.js";

const date = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const userSchema = z.object({ login: z.string().min(1) });
const collaboratorSchema = userSchema.extend({
  permissions: z
    .object({
      push: z.boolean().optional(),
      maintain: z.boolean().optional(),
      admin: z.boolean().optional(),
    })
    .optional(),
});
const repoSchema = z.object({
  full_name: z.string().regex(/^[^/]+\/[^/]+$/),
  archived: z.boolean(),
  pushed_at: date.nullish(),
});
const issueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  html_url: z.string(),
  repository_url: z.string(),
  user: userSchema.nullable(),
  created_at: date,
  closed_at: date.nullish(),
  pull_request: z.object({ merged_at: date.nullish() }).optional(),
});
const pullSchema = z.object({ merged_by: userSchema.nullable() });
const commitSchema = z.object({
  sha: z.string(),
  html_url: z.string(),
  author: userSchema.nullable(),
  commit: z.object({ message: z.string(), committer: z.object({ date }).nullable() }),
});
const searchCommitSchema = commitSchema.extend({
  repository: z.object({ full_name: z.string() }),
});
const commentSchema = z.object({
  user: userSchema.nullable(),
  body: z.string().nullish(),
  created_at: date,
  html_url: z.string(),
});
const advisorySchema = z.object({
  summary: z.string(),
  html_url: z.string(),
  published_at: date.nullish(),
  updated_at: date.nullish(),
  credits: z.array(z.object({ login: z.string().nullish(), user: userSchema.nullish() })).nullish(),
  publisher: userSchema.nullish(),
});

type SearchQuery =
  | {
      kind: "issues";
      qualifier: "created" | "closed" | "merged" | "updated";
      type: "issue" | "pull-request";
    }
  | { kind: "commits"; qualifier: "committer-date" };

function searchPath(query: SearchQuery, org: string, start: number, end: number): string {
  const type = query.kind === "issues" ? ` is:${query.type}` : "";
  return pathWithQuery(`/search/${query.kind}`, {
    q: `org:${org}${type} ${query.qualifier}:${new Date(start * 1000).toISOString()}..${new Date(end * 1000).toISOString()}`,
  });
}

function searchSeconds(window: ActivityWindow): [number, number] {
  return [Math.floor(window.sinceMs / 1000), Math.floor((window.untilMs - 1) / 1000)];
}

async function* search<T>(
  client: GithubClient,
  query: SearchQuery,
  org: string,
  window: ActivityWindow,
  itemSchema: z.ZodType<T>,
  first?: Awaited<ReturnType<GithubClient["get"]>>,
  afterPage?: () => Promise<void>,
): AsyncGenerator<T> {
  const { kind } = query;
  const schema = z.object({
    total_count: z.number().int().nonnegative(),
    incomplete_results: z.boolean().optional(),
    items: z.array(itemSchema),
  });
  async function* range(
    start: number,
    end: number,
    initial?: Awaited<ReturnType<GithubClient["get"]>>,
  ): AsyncGenerator<T> {
    let page = initial ?? (await client.get(searchPath(query, org, start, end)));
    let result = parse(schema, page.data);
    // The parsed page owns the useful fields; release bodies stripped by the schema,
    // including the caller's reused probe, before descending into split searches.
    page.data = undefined;
    if (result.total_count >= 1000 && start < end) {
      result.items = [];
      client.status.stats.searchSplits = Number(client.status.stats.searchSplits) + 1;
      // Search ranges are inclusive at second precision; disjoint children avoid cap-boundary duplicates.
      const mid = Math.floor((start + end) / 2);
      yield* range(start, mid);
      yield* range(mid + 1, end);
      return;
    }
    if (result.total_count >= 1000) {
      client.warn(
        `${org} ${kind}`,
        new GithubSourceError("Search cap reached within one second; some activity may be missing"),
      );
    }
    const seen = new Set<string>();
    let emitted = 0;
    for (;;) {
      if (result.incomplete_results) {
        client.warn(
          `${org} ${kind}`,
          new GithubSourceError("GitHub returned incomplete search results"),
        );
      }
      yield* result.items;
      await afterPage?.();
      emitted += result.items.length;
      if (!page.next || emitted >= 1000) {
        break;
      }
      if (seen.has(page.next)) {
        throw new GithubSourceError("Search pagination did not advance");
      }
      seen.add(page.next);
      page = await client.get(page.next);
      result = parse(schema, page.data);
      page.data = undefined;
    }
  }
  yield* range(...searchSeconds(window), first);
}

type Repository = z.infer<typeof repoSchema>;

function newStatus(): SourceStatus {
  return {
    ok: true,
    warnings: [],
    stats: { apiCalls: 0, reposScanned: 0, searchSplits: 0, advisoriesSkipped: 0 },
  };
}

function repoPath(repo: string): string {
  return `/repos/${repo.split("/").map(encodeURIComponent).join("/")}`;
}

function inWindow(timestamp: string | null | undefined, window: ActivityWindow): boolean {
  const atMs = timestamp ? Date.parse(timestamp) : Number.NaN;
  return atMs >= window.sinceMs && atMs < window.untilMs;
}

function commentTitle(body: string | null | undefined): string {
  const firstLine =
    body
      ?.split(/\r\n?|\n/, 1)[0]
      ?.trim()
      .replace(/\s+/g, " ") || "Comment";
  return truncateGraphemes(firstLine, 140);
}

async function listRepos(
  client: GithubClient,
  cfg: GithubSourceConfig,
): Promise<Map<string, Repository>> {
  const repos = new Map<string, Repository>();
  const excluded = new Set(cfg.excludeRepos.map((repo) => repo.toLowerCase()));
  for (const org of new Set(cfg.orgs)) {
    await client.attempt(`List repositories for ${org}`, async () => {
      for await (const repo of client.pages(
        pathWithQuery(`/orgs/${encodeURIComponent(org)}/repos`, { type: "all" }),
        repoSchema,
      )) {
        if (!repo.archived && !excluded.has(repo.full_name.toLowerCase())) {
          repos.set(repo.full_name.toLowerCase(), repo);
        }
      }
    });
  }
  return repos;
}

function coauthors(message: string, roster: Roster): string[] {
  const logins = new Set<string>();
  for (const match of message.matchAll(
    /^Co-authored-by:[ \t]*(.*?)[ \t]*(?:<([^<>\r\n]+)>)?[ \t]*$/gim,
  )) {
    const name = match[1]?.trim() ?? "";
    const email = match[2]?.trim() ?? "";
    const fromEmail = /^(?:\d+\+)?([a-z\d-]+)@users\.noreply\.github\.com$/i.exec(email)?.[1];
    const fromName = /^@?([a-z\d-]+)$/i.exec(name)?.[1];
    const login = (fromEmail ?? fromName)?.toLowerCase();
    if (login && (fromEmail || name.startsWith("@") || roster.byLogin.has(login))) {
      logins.add(login);
    }
  }
  return [...logins].toSorted();
}

export function createGithubSource(runtime: SourceRuntime): GithubSource {
  return {
    async loadRoster(cfg) {
      const status = newStatus();
      const client = new GithubClient(cfg, runtime, status);
      const people = new Map<string, Person>();
      const add = (login: string) => people.set(login.toLowerCase(), { github: [login] });
      for (const team of cfg.teams) {
        await client.attempt(`Load team ${team.org}/${team.slug}`, async () => {
          for await (const user of client.pages(
            pathWithQuery(
              `/orgs/${encodeURIComponent(team.org)}/teams/${encodeURIComponent(team.slug)}/members`,
              {},
            ),
            userSchema,
          )) {
            add(user.login);
          }
        });
      }
      if (cfg.includeDirectCollaborators) {
        for (const repo of (await listRepos(client, cfg)).values()) {
          await client.attempt(`Load collaborators for ${repo.full_name}`, async () => {
            for await (const user of client.pages(
              pathWithQuery(`${repoPath(repo.full_name)}/collaborators`, {
                affiliation: "direct",
              }),
              collaboratorSchema,
            )) {
              if (user.permissions?.push || user.permissions?.maintain || user.permissions?.admin) {
                add(user.login);
              }
            }
          });
        }
      }
      checkAbort(runtime.signal, ABORT_LABEL);
      runtime.logger.info(`team-reports: GitHub roster loaded: ${people.size} people`);
      return {
        people: [...people]
          .toSorted(([a], [b]) => a.localeCompare(b, "en"))
          .map(([, person]) => person),
        status,
      };
    },

    async collect(cfg, window, roster, emit) {
      const status = newStatus();
      const client = new GithubClient(cfg, runtime, status);
      checkAbort(runtime.signal, ABORT_LABEL);
      if (window.untilMs <= window.sinceMs) {
        throw new Error("Invalid GitHub activity window");
      }
      const repos = await listRepos(client, cfg);
      runtime.logger.info(`team-reports: GitHub repos listed: ${repos.size}`);
      let pending: ActivityEntry<GithubItem>[] = [];
      let itemCount = 0;
      let commitCount = 0;
      const flush = async () => {
        if (pending.length > 0) {
          const batch = pending;
          pending = [];
          await emit(batch);
        }
      };
      const active = new Set<string>();
      const updatedRepos = new Set<string>();
      // updated_at is an item's LAST update, so a later edit would hide in-window comments during
      // historical regeneration; bound discovery by now and let the comment endpoints filter events.
      const discoveryWindow: ActivityWindow = {
        sinceMs: window.sinceMs,
        untilMs: Math.max(window.untilMs, Date.now()),
      };
      const seenIssues = new Set<string>();
      const add = async (item: GithubItem) => {
        checkAbort(runtime.signal, ABORT_LABEL);
        if (item.atMs >= window.sinceMs && item.atMs < window.untilMs) {
          pending.push({
            key: JSON.stringify([item.kind, item.url, item.actor.toLowerCase(), item.atMs]),
            value: item,
          });
          itemCount++;
          if (item.kind === "commit") {
            commitCount++;
          }
          if (pending.length === 100) {
            await flush();
          }
        }
      };
      const addCommit = async (repo: string, commit: z.infer<typeof commitSchema>) => {
        const committedAt = commit.commit.committer?.date;
        if (!inWindow(committedAt, window)) {
          return;
        }
        active.add(repo.toLowerCase());
        await add({
          kind: "commit",
          repo,
          title: commit.commit.message.split(/\r?\n/, 1)[0] ?? "",
          url: commit.html_url,
          atMs: Date.parse(committedAt ?? ""),
          actor: commit.author?.login ?? "",
          coauthors: coauthors(commit.commit.message, roster),
        });
      };
      const collectRepoCommits = async (candidates: Repository[]) => {
        for (const repo of candidates) {
          await client.attempt(`Commits for ${repo.full_name}`, async () => {
            for await (const commit of client.pages(
              pathWithQuery(`${repoPath(repo.full_name)}/commits`, {
                since: new Date(window.sinceMs).toISOString(),
                until: new Date(window.untilMs).toISOString(),
              }),
              commitSchema,
              flush,
            )) {
              await addCommit(repo.full_name, commit);
            }
          });
          await flush();
        }
      };
      const orgCandidates = new Map<string, Repository[]>();
      for (const org of new Set(cfg.orgs)) {
        const orgRepos = [...repos.values()].filter(
          (repo) =>
            repo.full_name.slice(0, repo.full_name.indexOf("/")).toLowerCase() ===
            org.toLowerCase(),
        );
        if (orgRepos.length === 0) {
          continue;
        }
        // pushed_at also discovers commit-only repos; do not require issue activity to scan commits.
        const candidates = orgRepos.filter(
          (repo) => !repo.pushed_at || Date.parse(repo.pushed_at) >= window.sinceMs,
        );
        orgCandidates.set(org, candidates);
        for (const repo of candidates) {
          active.add(repo.full_name.toLowerCase());
        }
        for (const [qualifier, type] of [
          ["created", "issue"],
          ["created", "pull-request"],
          ["closed", "issue"],
          ["closed", "pull-request"],
          ["merged", "pull-request"],
        ] as const) {
          await client.attempt(`${type} ${qualifier} search for ${org}`, async () => {
            for await (const issue of search(
              client,
              { kind: "issues", qualifier, type },
              org,
              window,
              issueSchema,
              undefined,
              flush,
            )) {
              const repoName = /\/repos\/([^/]+\/[^/]+)\/?$/
                .exec(issue.repository_url)?.[1]
                ?.toLowerCase();
              const repo = repoName ? repos.get(repoName) : undefined;
              if (!repo) {
                continue;
              }
              const key = `${repo.full_name.toLowerCase()}#${issue.number}`;
              if (seenIssues.has(key)) {
                continue;
              }
              // Deduplicate event searches before emitting events or looking up the merger.
              seenIssues.add(key);
              active.add(repo.full_name.toLowerCase());
              const common = {
                repo: repo.full_name,
                number: issue.number,
                title: issue.title,
                url: issue.html_url,
                actor: issue.user?.login ?? "",
              };
              if (inWindow(issue.created_at, window)) {
                await add({
                  ...common,
                  kind: issue.pull_request ? "pr_opened" : "issue_opened",
                  atMs: Date.parse(issue.created_at),
                });
              }
              if (issue.pull_request?.merged_at) {
                if (!inWindow(issue.pull_request.merged_at, window)) {
                  continue;
                }
                let actor: string | undefined;
                await client.attempt(`Merger for ${key}`, async () => {
                  const pull = parse(
                    pullSchema,
                    (await client.get(`${repoPath(repo.full_name)}/pulls/${issue.number}`)).data,
                  );
                  actor = pull.merged_by?.login;
                });
                if (actor) {
                  await add({
                    ...common,
                    actor,
                    kind: "pr_merged",
                    atMs: Date.parse(issue.pull_request.merged_at),
                  });
                }
              } else if (inWindow(issue.closed_at, window)) {
                await add({
                  ...common,
                  kind: issue.pull_request ? "pr_closed" : "issue_closed",
                  atMs: Date.parse(issue.closed_at ?? ""),
                });
              }
            }
          });
          await flush();
        }
        for (const type of ["issue", "pull-request"] as const) {
          await client.attempt(`${type} updated search for ${org}`, async () => {
            for await (const issue of search(
              client,
              { kind: "issues", qualifier: "updated", type },
              org,
              discoveryWindow,
              issueSchema,
            )) {
              const repoName = /\/repos\/([^/]+\/[^/]+)\/?$/
                .exec(issue.repository_url)?.[1]
                ?.toLowerCase();
              if (repoName && repos.has(repoName)) {
                updatedRepos.add(repoName);
              }
            }
          });
        }
      }
      runtime.logger.info(
        `team-reports: GitHub issue searches done: ${itemCount} items, ${updatedRepos.size} updated-search repos`,
      );
      const strategies = new Set<string>();
      for (const [org, candidates] of orgCandidates) {
        if (candidates.length === 0) {
          continue;
        }
        if (candidates.length === 1) {
          // A single REST list costs no more requests and avoids the smaller search quota.
          strategies.add("per-repo");
          await collectRepoCommits(candidates);
        } else {
          await client.attempt(`Commit search for ${org}`, async () => {
            const first = await client.get(
              searchPath(
                { kind: "commits", qualifier: "committer-date" },
                org,
                ...searchSeconds(window),
              ),
            );
            const count = parse(
              z.object({ total_count: z.number().int().nonnegative() }),
              first.data,
            ).total_count;
            // Reuse the probe when search is cheaper; prefer repo lists when estimated search pages exceed repo count.
            if (Math.ceil(count / 100) > candidates.length) {
              strategies.add("per-repo");
              await collectRepoCommits(candidates);
            } else {
              strategies.add("search");
              for await (const commit of search(
                client,
                { kind: "commits", qualifier: "committer-date" },
                org,
                window,
                searchCommitSchema,
                first,
                flush,
              )) {
                const repo = repos.get(commit.repository.full_name.toLowerCase());
                if (repo) {
                  await addCommit(repo.full_name, commit);
                }
              }
            }
          });
        }
        await flush();
      }
      status.stats.commitStrategy = strategies.size > 1 ? "mixed" : ([...strategies][0] ?? "none");
      runtime.logger.info(
        `team-reports: GitHub commits done: ${status.stats.commitStrategy}, ${commitCount} items`,
      );
      for (const key of updatedRepos) {
        active.add(key);
      }
      for (const key of [...active].toSorted()) {
        const repo = repos.get(key);
        if (!repo) {
          continue;
        }
        status.stats.reposScanned = Number(status.stats.reposScanned) + 1;
        for (const [endpoint, kind] of [
          ["issues/comments", "issue_comment"],
          ["pulls/comments", "review_comment"],
        ] as const) {
          await client.attempt(`${kind} for ${repo.full_name}`, async () => {
            for await (const comment of client.pages(
              pathWithQuery(`${repoPath(repo.full_name)}/${endpoint}`, {
                since: new Date(window.sinceMs).toISOString(),
              }),
              commentSchema,
              flush,
            )) {
              if (inWindow(comment.created_at, window)) {
                await add({
                  kind,
                  repo: repo.full_name,
                  title: commentTitle(comment.body),
                  body: comment.body ?? "",
                  url: comment.html_url,
                  atMs: Date.parse(comment.created_at),
                  actor: comment.user?.login ?? "",
                });
              }
            }
          });
          await flush();
        }
      }
      let advisoryReposScanned = 0;
      for (const [, repo] of [...repos].toSorted(([a], [b]) => a.localeCompare(b, "en"))) {
        advisoryReposScanned++;
        await client.attempt(`Advisories for ${repo.full_name}`, async () => {
          try {
            for await (const advisory of client.pages(
              pathWithQuery(`${repoPath(repo.full_name)}/security-advisories`, {
                sort: "updated",
                direction: "desc",
              }),
              advisorySchema,
              flush,
            )) {
              // Newest-first updates let us stop before fetching any older pages.
              if (advisory.updated_at && Date.parse(advisory.updated_at) < window.sinceMs) {
                break;
              }
              const advisoryDate = inWindow(advisory.updated_at, window)
                ? advisory.updated_at
                : advisory.published_at;
              if (!inWindow(advisoryDate, window)) {
                continue;
              }
              const actors = new Set(
                [
                  advisory.publisher?.login,
                  ...(advisory.credits ?? []).map((credit) => credit.user?.login ?? credit.login),
                ].filter((login): login is string => Boolean(login)),
              );
              for (const actor of actors) {
                await add({
                  kind: "security_advisory",
                  repo: repo.full_name,
                  title: advisory.summary,
                  url: advisory.html_url,
                  atMs: Date.parse(advisoryDate ?? ""),
                  actor,
                });
              }
            }
          } catch (error) {
            checkAbort(runtime.signal, ABORT_LABEL);
            if (
              error instanceof GithubHttpError &&
              (error.status === 403 || error.status === 404)
            ) {
              status.stats.advisoriesSkipped = Number(status.stats.advisoriesSkipped) + 1;
            } else {
              throw error;
            }
          }
        });
        await flush();
      }
      checkAbort(runtime.signal, ABORT_LABEL);
      runtime.logger.info(
        `team-reports: GitHub comments scanned: ${status.stats.reposScanned} repos; advisories scanned: ${advisoryReposScanned} repos`,
      );
      if (Number(status.stats.advisoriesSkipped) > 0) {
        runtime.logger.info(
          `team-reports: GitHub advisories skipped: ${status.stats.advisoriesSkipped} repos (HTTP 403/404; no advisories visible)`,
        );
      }
      await flush();
      return status;
    },
  };
}

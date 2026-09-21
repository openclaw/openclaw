import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { execGhRead, execPlainGh } from "../lib/plain-gh.mjs";
import {
  isGraphqlQuotaExhausted,
  parseGithubResponse,
  rateLimitRetryGuidance,
} from "./gh-api-preflight.mjs";

function githubAccessFailure(error) {
  const limited = (text) =>
    typeof text === "string" &&
    /(?:\bHTTP(?:\/\d+(?:\.\d+)?)?\s+429\b|\b429 too many requests\b|\bRATE_LIMIT(?:ED)?\b|\brate[ -]limit(?:ed|ing)?\b)/i.test(
      text,
    );
  const stderr = String(error?.stderr ?? "");
  const stdout = String(error?.stdout ?? "");
  const forbidden =
    /(?:\bHTTP(?:\/\d+(?:\.\d+)?)?\s+403\b|\b403 forbidden\b)/i.test(stderr) ||
    /^HTTP\/\d+(?:\.\d+)? 403(?:\s|$)/m.test(stdout);
  if (limited(stderr) || /^HTTP\/\d+(?:\.\d+)? 429(?:\s|$)/m.test(stdout)) {
    return "quota";
  }
  const boundary = /\r?\n\r?\n/.exec(stdout);
  if (
    forbidden &&
    /^(?:x-ratelimit-remaining:\s*0|retry-after:\s*\d+)\s*$/im.test(
      boundary ? stdout.slice(0, boundary.index) : "",
    )
  ) {
    return "quota";
  }
  try {
    const body = JSON.parse(boundary ? stdout.slice(boundary.index + boundary[0].length) : stdout);
    if (
      limited(body?.message) ||
      (Array.isArray(body?.errors) &&
        body.errors.some(
          (entry) =>
            ["RATE_LIMIT", "RATE_LIMITED"].includes(entry?.type) || limited(entry?.message),
        ))
    ) {
      return "quota";
    }
  } catch {
    // A non-JSON response cannot supply additional quota evidence.
  }
  return forbidden ? "forbidden" : undefined;
}

function invalidMetadata(message) {
  const error = new Error(message);
  error.status = 65;
  return error;
}

function resourceFor(args) {
  return args.includes("graphql") || args[0] === "pr" ? "graphql" : "core";
}

function quotaHostname(args, env) {
  const hostname = option(args, "--hostname");
  if (hostname || !["browse", "pr", "run", "workflow"].includes(args[0])) {
    return hostname;
  }
  const repository = option(args, "--repo") || option(args, "-R") || env.GH_REPO || "";
  const qualified = /^(?:https?:\/\/)?([^/]+)\/[^/]+\/[^/]+\/?$/.exec(repository);
  if (!qualified) {
    return undefined;
  }
  try {
    return new URL(`https://${qualified[1]}`).host;
  } catch {
    return undefined;
  }
}

function quotaSummary(resource, quota) {
  const number = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : "unknown");
  const reset =
    Number.isSafeInteger(quota?.reset) && quota.reset >= 0 && quota.reset <= 253402300799
      ? new Date(quota.reset * 1000).toISOString().replace(".000Z", "Z")
      : "unknown";
  return `${resource} ${number(quota?.remaining)}/${number(quota?.limit)} reset=${reset}`;
}

// Keep the failing call's route and host: a pooled reader and the mutation CLI
// may use different credentials. Never print raw API error bodies in quota diagnostics.
export function execPrGh(args, options = {}, route = "read") {
  const deadline = options.timeout > 0 ? Date.now() + options.timeout : undefined;
  const run = route === "plain" ? execPlainGh : execGhRead;
  const inherited = options.env ?? process.env;
  const selectedGit = inherited.OPENCLAW_PR_GIT || inherited.GIT_EXEC;
  const notifier = inherited.OPENCLAW_PR_LOCK_NOTIFY_FD === "3" ? [3] : [];
  const captured = {
    ...options,
    stdio: [
      Array.isArray(options.stdio) ? options.stdio[0] : "ignore",
      "pipe",
      "pipe",
      ...notifier,
    ],
  };
  let gitPath;
  try {
    if (selectedGit) {
      // gh resolves Git through PATH even for local repository selection. This
      // call-owned adapter also covers advisory commands without a supervisor.
      gitPath = mkdtempSync(join(tmpdir(), "openclaw-pr-gh-git-"));
      symlinkSync(resolve(options.cwd ?? process.cwd(), selectedGit), join(gitPath, "git"));
      captured.env = { ...inherited, PATH: `${gitPath}${delimiter}${inherited.PATH ?? ""}` };
    }
    return run(args, captured);
  } catch (error) {
    const graphqlQuotaExhausted = resourceFor(args) === "graphql" && isGraphqlQuotaExhausted(error);
    const reason = githubAccessFailure(error);
    if (!reason) {
      throw error;
    }
    const response = parseGithubResponse(String(error?.stdout ?? ""));
    let diagnostic;
    if (response.status) {
      const { status, resource, remaining, limit, resetUtc, retryAfter } = response;
      diagnostic = `original response: HTTP ${status}; resource=${resource}; remaining=${remaining ?? "unknown"}; limit=${limit ?? "unknown"}; reset=${resetUtc}${retryAfter === undefined ? "" : `; retry-after=${retryAfter}s`}.`;
      diagnostic +=
        reason === "quota"
          ? ` ${rateLimitRetryGuidance(response)}`
          : " Check access policy before retrying.";
    } else if (graphqlQuotaExhausted) {
      diagnostic = "GraphQL primary quota is exhausted; the original reset time is unknown.";
    } else {
      const hostname = quotaHostname(args, inherited);
      const host = hostname ? ["--hostname", hostname] : [];
      let resources;
      try {
        // Diagnostics share the failed read's budget; they must not extend a watcher deadline.
        const remaining = deadline === undefined ? undefined : deadline - Date.now();
        if (remaining !== undefined && remaining <= 0) {
          throw error;
        }
        resources = JSON.parse(
          run(["api", ...host, "rate_limit"], {
            ...captured,
            ...(remaining === undefined ? {} : { timeout: remaining }),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe", ...notifier],
          }),
        ).resources;
      } catch {
        // A failed diagnostics probe must not conceal the original resource or retry it.
      }
      diagnostic = `Supplemental quota probe (remaining/limit; not the failing response): ${quotaSummary("graphql", resources?.graphql)} ${quotaSummary("core", resources?.core)}. Check access or throttling before retrying; the original response's quota and reset are unknown.`;
    }
    const failure = new Error(
      `GitHub API request failed (resource=${resourceFor(args)}); ${diagnostic}`,
    );
    failure.code = "OPENCLAW_GH_ACCESS";
    failure.status = reason === "quota" ? 75 : 77;
    failure.graphqlQuotaExhausted = graphqlQuotaExhausted;
    throw failure;
  } finally {
    if (gitPath) {
      try {
        rmSync(gitPath, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup must preserve the result and combined JSON output.
      }
    }
  }
}

export function execPrGhJson(args, options = {}, route = "read") {
  return JSON.parse(execPrGh(args, { ...options, encoding: "utf8" }, route));
}

function repositoryLocator(explicit, route, readOptions = () => ({})) {
  const selected = explicit || process.env.GH_REPO;
  const qualified =
    /^(?:https:\/\/)?([A-Za-z0-9.-]+(?::[0-9]+)?)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      selected ?? "",
    );
  // A host-qualified locator already names the API target. Its ensuing REST
  // read verifies the repository; another browse HEAD adds no authority.
  if (qualified) {
    return { host: qualified[1], name: qualified[2] };
  }
  // gh browse shares PR commands' SmartBaseRepoFunc and preserves the configured
  // default and host. --no-browser only verifies it with REST HEAD and prints its URL.
  const value = execPrGh(
    ["browse", "--no-browser", ...(explicit ? ["--repo", explicit] : [])],
    { ...readOptions(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    route,
  ).trim();
  const match =
    /^(?:(?:https?:\/\/|ssh:\/\/git@|git@)?([^/:]+(?::[0-9]+)?)[:/])?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(
      value,
    );
  if (!match?.[1]) {
    throw new Error("Cannot resolve the GitHub repository; set GH_REPO to owner/repo.");
  }
  return { host: match[1], name: match[2] };
}

function option(args, name) {
  const assignment = args.find((arg) => arg.startsWith(`${name}=`));
  if (assignment) {
    return assignment.slice(name.length + 1);
  }
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

function api(repo, endpoint, route, paginate = false, options = {}) {
  return execPrGhJson(
    [
      "api",
      "--hostname",
      repo.host,
      endpoint,
      ...(paginate ? ["--paginate", "--slurp"] : []),
      ...(route === "plain" || options.revalidate ? ["-H", "Cache-Control: max-age=0"] : []),
    ],
    { ...options.readOptions?.(), stdio: ["ignore", "pipe", "pipe"] },
    route,
  );
}

function pageItems(pages) {
  if (!Array.isArray(pages) || pages.length === 0 || pages.some((page) => !Array.isArray(page))) {
    throw invalidMetadata("GitHub returned malformed paginated metadata.");
  }
  return pages.flat();
}

function user(record) {
  return record == null
    ? record
    : {
        id: record.node_id,
        login: record.login,
        is_bot: record.type === "Bot",
        ...(record.name === undefined ? {} : { name: record.name }),
      };
}

function selectFields(record, fields, kind) {
  return Object.fromEntries(
    fields.map((field) => {
      if (!Object.hasOwn(record, field)) {
        throw new Error(`Unsupported REST ${kind} metadata field: ${field}`);
      }
      return [field, record[field]];
    }),
  );
}

function readPr(repo, pr, fields, route, options = {}) {
  if (!/^[1-9][0-9]*$/.test(pr)) {
    throw new Error("Expected a positive PR number.");
  }
  // These reads bind source acquisition and publication to the live PR head.
  // Revalidate each observation through the relay, including both sides of a fetch.
  const freshOptions = { ...options, revalidate: true };
  const record = api(repo, `repos/${repo.name}/pulls/${pr}`, route, false, freshOptions);
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("GitHub did not return one PR JSON object.");
  }
  const result = {
    number: record.number,
    title: record.title,
    state: record.merged_at ? "MERGED" : record.state?.toUpperCase(),
    isDraft: record.draft,
    author: user(record.user),
    baseRefName: record.base?.ref,
    baseRefOid: record.base?.sha,
    headRefName: record.head?.ref,
    headRefOid: record.head?.sha,
    headRepository:
      record.head?.repo == null
        ? record.head?.repo
        : {
            id: record.head.repo.node_id,
            name: record.head.repo.name,
            nameWithOwner: record.head.repo.full_name,
            url: record.head.repo.html_url,
          },
    headRepositoryOwner: user(record.head?.repo?.owner),
    isCrossRepository: [record.head?.repo?.id, record.base?.repo?.id].every(
      (id) => Number.isSafeInteger(id) && id > 0,
    )
      ? record.head.repo.id !== record.base.repo.id
      : undefined,
    url: record.html_url,
    body: record.body,
    labels: record.labels?.map((label) => ({
      id: label.node_id,
      name: label.name,
      description: label.description,
      color: label.color,
    })),
    assignees: record.assignees?.map(user),
    changedFiles: record.changed_files,
    additions: record.additions,
    deletions: record.deletions,
    mergeable:
      record.mergeable === true
        ? "MERGEABLE"
        : record.mergeable === false
          ? "CONFLICTING"
          : "UNKNOWN",
    mergeStateStatus: record.mergeable_state?.toUpperCase(),
  };
  if (fields.includes("files")) {
    result.files = pageItems(
      api(repo, `repos/${repo.name}/pulls/${pr}/files?per_page=100`, "plain", true, freshOptions),
    ).map((file) => ({
      path: file.filename,
      additions: file.additions,
      deletions: file.deletions,
      changeType: file.status === "removed" ? "DELETED" : file.status?.toUpperCase(),
    }));
  }
  return selectFields(result, fields, "PR");
}

export function createPrMetadataReader(repository) {
  let repo;
  return (pr, fields, readOptions = () => ({})) => {
    repo ??= repositoryLocator(repository, "read", readOptions);
    return readPr(repo, String(pr), fields, "read", { readOptions, revalidate: true });
  };
}

function readCommitAuthors(repository, hostname, commits, route) {
  const oid = /^[0-9a-f]{40}$/;
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    !/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(hostname) ||
    !Array.isArray(commits) ||
    !commits.every((commit) => oid.test(commit?.oid) && typeof commit.changesTree === "boolean") ||
    new Set(commits.map((commit) => commit.oid)).size !== commits.length
  ) {
    throw invalidMetadata("Invalid source commit author request.");
  }
  const remaining = new Map(commits.map((commit) => [commit.oid, commit]));
  const authors = new Map();
  let batchSize = 100;
  let cursor = commits.length - 1;
  while (remaining.size > 0) {
    while (!remaining.has(commits[cursor].oid)) {
      cursor -= 1;
    }
    const head = commits[cursor].oid;
    const limit = Math.min(batchSize, remaining.size);
    const page = execPrGhJson(
      ["api", "--hostname", hostname, `repos/${repository}/commits?sha=${head}&per_page=${limit}`],
      {},
      route,
    );
    if (
      !Array.isArray(page) ||
      page.length === 0 ||
      page.length > limit ||
      !page.every((commit) => oid.test(commit?.sha)) ||
      new Set(page.map((commit) => commit.sha)).size !== page.length ||
      !page.some((commit) => commit.sha === head)
    ) {
      throw invalidMetadata("Cannot establish the requested source commit author.");
    }
    let resolved = 0;
    for (const commit of page) {
      const source = remaining.get(commit.sha);
      if (!source) {
        continue;
      }
      const author = commit.commit?.author;
      const account = commit.author;
      if (
        typeof author?.name !== "string" ||
        typeof author.email !== "string" ||
        (account !== null &&
          (typeof account?.login !== "string" ||
            !account.login ||
            typeof account.type !== "string" ||
            !account.type))
      ) {
        throw invalidMetadata("Cannot establish the requested source commit author.");
      }
      authors.set(commit.sha, {
        name: author.name,
        email: author.email,
        user: account === null ? null : { login: account.login, type: account.type },
        changesTree: source.changesTree,
      });
      remaining.delete(commit.sha);
      resolved += 1;
    }
    // A merge can introduce unrelated ancestry. Stop expanding after the first
    // mixed page: N source commits require at most N calls and N + 99 rows.
    if (resolved < limit) {
      batchSize = 1;
    }
  }
  return commits.map((commit) => authors.get(commit.oid));
}

function assignReviewer(pr, reviewer) {
  if (!/^[1-9][0-9]*$/.test(pr) || typeof reviewer !== "string" || !reviewer.trim()) {
    throw new Error("Expected a PR number and reviewer login.");
  }
  const repo = repositoryLocator(undefined, "plain");
  const result = execPrGhJson(
    [
      "api",
      "--hostname",
      repo.host,
      `repos/${repo.name}/issues/${pr}/assignees`,
      "--method",
      "POST",
      "-f",
      `assignees[]=${reviewer}`,
    ],
    {},
    "plain",
  );
  if (
    !Array.isArray(result?.assignees) ||
    !result.assignees.some((assignee) => assignee?.login === reviewer)
  ) {
    throw invalidMetadata("GitHub did not assign the requested reviewer.");
  }
}

function main([requestedRoute, ...args]) {
  if (!["plain", "read", "plain-quota"].includes(requestedRoute)) {
    throw new Error("Expected a GitHub CLI route.");
  }
  const route = requestedRoute === "plain-quota" ? "plain" : requestedRoute;
  if (route === "plain" && args[0] === "assign-reviewer" && args.length === 3) {
    assignReviewer(args[1], args[2]);
    return;
  }
  if (args[0] === "commit-authors" && args.length === 3) {
    const authors = readCommitAuthors(args[1], args[2], JSON.parse(readFileSync(0, "utf8")), route);
    process.stdout.write(`${JSON.stringify(authors)}\n`);
    return;
  }
  let result;
  // Keep the existing caller/artifact field contract while sourcing ordinary
  // metadata through REST. Native landing owns the narrower quota fallback for
  // required checks and ordinary squash admission; special routes keep GraphQL.
  if (["pr", "repo"].includes(args[0]) && args[1] === "view") {
    const repo = repositoryLocator(option(args, "--repo") || option(args, "-R"), route);
    const fields = option(args, "--json")?.split(",");
    if (!fields?.length) {
      throw new Error("GitHub metadata reads require explicit JSON fields.");
    }
    if (args[0] === "pr") {
      result = readPr(repo, args[2], fields, route);
    } else {
      const record = api(repo, `repos/${repo.name}`, route);
      result = selectFields(
        { nameWithOwner: record.full_name, url: record.html_url, id: record.node_id },
        fields,
        "repository",
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else {
    if (args[0] === "pr" && !option(args, "--repo") && !option(args, "-R")) {
      const repo = repositoryLocator(undefined, route);
      args.push("--repo", `https://${repo.host}/${repo.name}`);
    }
    process.stdout.write(
      execPrGh(args, { encoding: "utf8", stdio: ["inherit", "pipe", "pipe"] }, route),
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const args = process.argv.slice(3);
    const query = args.find((arg) => arg.startsWith("query="));
    const quotaRead =
      (args[0] === "pr" && args[1] === "checks") ||
      (args[0] === "api" && args.includes("graphql") && /^query=\s*query\b/.test(query ?? ""));
    if (process.argv[2] === "plain-quota" && quotaRead && error.graphqlQuotaExhausted) {
      process.stdout.write('{"graphqlQuotaExhausted":true}\n');
    } else {
      // Quota errors contain only bounded numeric metadata, never raw response text.
      if (error.code !== "OPENCLAW_GH_ACCESS" && error.stdout) {
        process.stdout.write(error.stdout);
      }
      console.error(
        error.code === "OPENCLAW_GH_ACCESS"
          ? error.message
          : String(error.stderr || error.message).trim(),
      );
      process.exitCode = Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
    }
  }
}

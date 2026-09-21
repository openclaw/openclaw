import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { isDirectRunUrl } from "../lib/direct-run.mjs";
import { execGhRead, execPlainGh } from "../lib/plain-gh.mjs";
import {
  isGraphqlQuotaExhausted,
  isCoreQuotaExhausted,
  parseGithubResponse,
  rateLimitRetryGuidance,
  readWriterLogin,
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
    const coreQuotaExhausted = resourceFor(args) === "core" && isCoreQuotaExhausted(error);
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
    } else if (graphqlQuotaExhausted || coreQuotaExhausted) {
      diagnostic = `${graphqlQuotaExhausted ? "GraphQL" : "REST core"} primary quota is exhausted; the original reset time is unknown.`;
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
    failure.coreQuotaExhausted = coreQuotaExhausted;
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
  // Noninteractive browse keeps gh's default/host resolution local. --no-browser
  // adds a REST HEAD whose generic 403 hides quota evidence. The child-only
  // launcher prints the address; the subsequent API read validates authority.
  const options = readOptions();
  const value = execPrGh(
    ["browse", ...(explicit ? ["--repo", explicit] : [])],
    {
      ...options,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...(options.env ?? process.env),
        // gh parses its launcher with shlex, then appends the URL as one argument.
        GH_BROWSER: `'${process.execPath.replaceAll("'", "'\\''")}' -p 'process.argv[1]'`,
      },
    },
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

function restPreferred(read, fallback) {
  try {
    return read();
  } catch (error) {
    if (!error.coreQuotaExhausted) {
      throw error;
    }
    return fallback();
  }
}

function graphql(repo, query, variables, route, options = {}) {
  const result = execPrGhJson(
    [
      "api",
      "--hostname",
      repo.host,
      "graphql",
      "--input",
      "-",
      ...(route === "plain" || options.revalidate ? ["-H", "Cache-Control: max-age=0"] : []),
    ],
    {
      ...options.readOptions?.(),
      input: JSON.stringify({ query, variables }),
      stdio: ["pipe", "pipe", "pipe"],
    },
    route,
  );
  if (!result?.data || result.errors != null) {
    throw invalidMetadata("GitHub returned incomplete GraphQL metadata.");
  }
  return result.data;
}

function namedRepository(name, host) {
  if (
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name ?? "") ||
    !/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(host ?? "")
  ) {
    throw invalidMetadata("Invalid repository address.");
  }
  return { name, host };
}

function repositoryVariables(repo) {
  const [owner, name] = repo.name.split("/");
  return { owner, name };
}

function connectionNodes(readPage) {
  const nodes = [];
  const cursors = new Set();
  let cursor = null;
  let total;
  do {
    const page = readPage(cursor);
    if (
      !Array.isArray(page?.nodes) ||
      !Number.isSafeInteger(page.totalCount) ||
      page.totalCount < 0 ||
      typeof page.pageInfo?.hasNextPage !== "boolean" ||
      (total !== undefined && total !== page.totalCount)
    ) {
      throw invalidMetadata("GitHub returned incomplete GraphQL pagination.");
    }
    total = page.totalCount;
    nodes.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) {
      break;
    }
    cursor = page.pageInfo.endCursor;
    if (
      typeof cursor !== "string" ||
      !cursor ||
      cursors.has(cursor) ||
      page.nodes.length === 0 ||
      nodes.length >= total
    ) {
      throw invalidMetadata("GitHub returned incomplete GraphQL pagination.");
    }
    cursors.add(cursor);
  } while (cursor !== null);
  if (nodes.length !== total) {
    throw invalidMetadata("GitHub returned incomplete GraphQL pagination.");
  }
  return nodes;
}

function validateRepoAuthority(repo, record) {
  if (
    !record ||
    !Number.isSafeInteger(record.databaseId) ||
    record.databaseId <= 0 ||
    typeof record.id !== "string" ||
    !record.id ||
    typeof record.nameWithOwner !== "string" ||
    record.nameWithOwner.toLowerCase() !== repo.name.toLowerCase() ||
    typeof record.url !== "string" ||
    record.url.toLowerCase() !== `https://${repo.host}/${repo.name}`.toLowerCase()
  ) {
    throw invalidMetadata("GitHub returned invalid repository authority.");
  }
}

function readRepoAuthority(repo, route) {
  return restPreferred(
    () => api(repo, `repos/${repo.name}`, route, false, { revalidate: true }),
    () => {
      const record = graphql(
        repo,
        "query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id databaseId nameWithOwner url}}",
        repositoryVariables(repo),
        route,
      ).repository;
      validateRepoAuthority(repo, record);
      return {
        id: record.databaseId,
        node_id: record.id,
        full_name: record.nameWithOwner,
        html_url: record.url,
      };
    },
  );
}

function readIssueComments(repo, pr, route) {
  if (!/^[1-9][0-9]*$/.test(pr ?? "")) {
    throw invalidMetadata("Expected a positive PR number.");
  }
  return restPreferred(
    () => {
      const pages = api(
        repo,
        `repos/${repo.name}/issues/${pr}/comments?per_page=100`,
        route,
        true,
        { revalidate: true },
      );
      pageItems(pages);
      return pages;
    },
    () => {
      const nodes = connectionNodes(
        (cursor) =>
          graphql(
            repo,
            "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{id databaseId body url createdAt updatedAt author{login __typename ... on User{id databaseId} ... on Bot{id databaseId}}}}}}}",
            { ...repositoryVariables(repo), number: Number(pr), cursor },
            route,
          ).repository?.pullRequest?.comments,
      );
      const seen = new Set();
      const comments = nodes.map((node) => {
        if (
          !node ||
          !Number.isSafeInteger(node.databaseId) ||
          node.databaseId <= 0 ||
          seen.has(node.databaseId) ||
          typeof node.body !== "string" ||
          typeof node.url !== "string"
        ) {
          throw invalidMetadata("GitHub returned invalid issue comments.");
        }
        seen.add(node.databaseId);
        const author = node.author;
        if (
          author !== null &&
          (typeof author?.login !== "string" ||
            !author.login ||
            typeof author.__typename !== "string")
        ) {
          throw invalidMetadata("GitHub returned invalid comment authors.");
        }
        return {
          id: node.databaseId,
          node_id: node.id,
          body: node.body,
          html_url: node.url,
          created_at: node.createdAt,
          updated_at: node.updatedAt,
          user:
            author === null
              ? null
              : {
                  id: author?.databaseId,
                  node_id: author?.id,
                  login:
                    author?.__typename === "Bot" && !author.login.endsWith("[bot]")
                      ? `${author.login}[bot]`
                      : author?.login,
                  type: author?.__typename,
                },
        };
      });
      return [comments];
    },
  );
}

function writerLogin(host) {
  let response;
  let status = 0;
  try {
    response = execPrGh(
      ["api", ...(host ? ["--hostname", host] : []), "user", "--include"],
      { encoding: "utf8" },
      "plain",
    );
  } catch (error) {
    if (error.coreQuotaExhausted) {
      response = execPrGh(
        [
          "api",
          ...(host ? ["--hostname", host] : []),
          "graphql",
          "--include",
          "-f",
          "query=query{viewer{login}}",
        ],
        { encoding: "utf8" },
        "plain",
      );
      const parsed = parseGithubResponse(response);
      const login = parsed.body?.data?.viewer?.login;
      if (
        parsed.status !== "200" ||
        parsed.body?.errors != null ||
        typeof login !== "string" ||
        !login.trim()
      ) {
        throw invalidMetadata("GitHub did not verify the GraphQL writer identity.");
      }
      return login;
    }
    if (error.code === "OPENCLAW_GH_ACCESS") {
      throw error;
    }
    response = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    status = error.status || 1;
  }
  return readWriterLogin(status, response).trim();
}

function readAuthorPermission(repo, login, route) {
  if (typeof login !== "string" || !login) {
    throw invalidMetadata("Expected an author login.");
  }
  return restPreferred(
    () =>
      api(repo, `repos/${repo.name}/collaborators/${encodeURIComponent(login)}/permission`, route),
    () => {
      try {
        const edges = connectionNodes((cursor) => {
          const connection = graphql(
            repo,
            "query($owner:String!,$name:String!,$login:String!,$cursor:String){repository(owner:$owner,name:$name){collaborators(first:100,query:$login,after:$cursor){totalCount pageInfo{hasNextPage endCursor} edges{permission node{login}}}}}",
            { ...repositoryVariables(repo), login, cursor },
            route,
          ).repository?.collaborators;
          return { ...connection, nodes: connection?.edges };
        });
        const matches = edges.filter((edge) => edge?.node?.login === login);
        if (matches.length === 0) {
          return { permission: "none" };
        }
        const permission = matches[0]?.permission;
        return {
          permission:
            matches.length === 1 &&
            ["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"].includes(permission)
              ? permission.toLowerCase()
              : "unknown",
        };
      } catch (error) {
        if (error.status === 75) {
          throw error;
        }
        return { permission: "unknown" };
      }
    },
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

function readPrRest(repo, pr, fields, route, options = {}) {
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
  if (
    fields.includes("baseRepository") &&
    (typeof record.base?.repo?.full_name !== "string" ||
      typeof record.base.repo.html_url !== "string" ||
      record.base.repo.full_name.toLowerCase() !== repo.name.toLowerCase() ||
      record.base.repo.html_url.toLowerCase() !== `https://${repo.host}/${repo.name}`.toLowerCase())
  ) {
    throw invalidMetadata("GitHub PR base repository does not match the requested repository.");
  }
  const result = {
    number: record.number,
    title: record.title,
    state: record.merged_at ? "MERGED" : record.state?.toUpperCase(),
    isDraft: record.draft,
    author: user(record.user),
    baseRefName: record.base?.ref,
    baseRefOid: record.base?.sha,
    baseRepository:
      record.base?.repo == null
        ? record.base?.repo
        : {
            id: record.base.repo.node_id,
            databaseId: record.base.repo.id,
            nameWithOwner: record.base.repo.full_name,
            url: record.base.repo.html_url,
          },
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

function readPr(repo, pr, fields, route, options = {}) {
  return restPreferred(
    () => readPrRest(repo, pr, fields, route, options),
    () => {
      const connections = {
        files: "path additions deletions changeType",
        labels: "id name description color",
        assignees: "id login name __typename",
      };
      const selections = {
        number: "number",
        title: "title",
        state: "state",
        isDraft: "isDraft",
        author: "author{login __typename ... on User{id name} ... on Bot{id}}",
        baseRefName: "baseRefName",
        baseRefOid: "baseRefOid",
        headRefName: "headRefName",
        headRefOid: "headRefOid",
        headRepository: "headRepository{id name nameWithOwner url}",
        headRepositoryOwner: "headRepositoryOwner{id login __typename ... on User{name}}",
        isCrossRepository: "isCrossRepository",
        url: "url",
        body: "body",
        changedFiles: "changedFiles",
        additions: "additions",
        deletions: "deletions",
        mergeable: "mergeable",
        mergeStateStatus: "mergeStateStatus",
      };
      const needsBaseRepository = fields.includes("baseRepository");
      const scalarFields = fields.filter(
        (field) => field !== "baseRepository" && !Object.hasOwn(connections, field),
      );
      const selection = Object.values(selectFields(selections, scalarFields, "PR")).join(" ");
      const freshOptions = { ...options, revalidate: true };
      const variables = { ...repositoryVariables(repo), number: Number(pr) };
      // A top-level pr view can be projected back to REST by a relay. An explicit
      // GraphQL request both selects the independent quota and carries freshness.
      const repository =
        scalarFields.length || needsBaseRepository
          ? graphql(
              repo,
              `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){${needsBaseRepository ? "id databaseId nameWithOwner url " : ""}pullRequest(number:$number){${selection || "id"}}}}`,
              variables,
              route,
              freshOptions,
            ).repository
          : null;
      const result = scalarFields.length || needsBaseRepository ? repository?.pullRequest : {};
      if (!result || typeof result !== "object" || Array.isArray(result)) {
        throw invalidMetadata("GitHub did not return one PR JSON object.");
      }
      if (needsBaseRepository) {
        validateRepoAuthority(repo, repository);
        const { id, databaseId, nameWithOwner, url } = repository;
        result.baseRepository = { id, databaseId, nameWithOwner, url };
      }
      const actor = (record) =>
        record == null ? record : user({ ...record, node_id: record.id, type: record.__typename });
      for (const field of ["author", "headRepositoryOwner"]) {
        if (fields.includes(field)) {
          result[field] = actor(result[field]);
        }
      }
      for (const field of fields.filter((candidate) => Object.hasOwn(connections, candidate))) {
        const nodes = connectionNodes(
          (cursor) =>
            graphql(
              repo,
              `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){${field}(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{${connections[field]}}}}}}`,
              { ...variables, cursor },
              route,
              freshOptions,
            ).repository?.pullRequest?.[field],
        );
        if (
          field === "files" &&
          (nodes.some((file) => typeof file?.path !== "string") ||
            new Set(nodes.map((file) => file.path)).size !== nodes.length)
        ) {
          throw invalidMetadata("GitHub returned invalid PR files.");
        }
        result[field] = field === "assignees" ? nodes.map(actor) : nodes;
      }
      return selectFields(result, fields, "PR");
    },
  );
}

export function createPrMetadataReader(repository) {
  let repo;
  return (pr, fields, readOptions = () => ({})) => {
    repo ??= repositoryLocator(repository, "read", readOptions);
    return readPr(repo, String(pr), fields, "read", { readOptions });
  };
}

function commitAuthor(author, account, changesTree) {
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
  return {
    name: author.name,
    email: author.email,
    user: account === null ? null : { login: account.login, type: account.type },
    changesTree,
  };
}

function readCommitAuthorsRest(repository, hostname, commits, route) {
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
      authors.set(
        commit.sha,
        commitAuthor(commit.commit?.author, commit.author, source.changesTree),
      );
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

function readCommitAuthors(repository, hostname, commits, route) {
  return restPreferred(
    () => readCommitAuthorsRest(repository, hostname, commits, route),
    () => {
      const repo = namedRepository(repository, hostname);
      const result = [];
      for (let start = 0; start < commits.length; start += 100) {
        const batch = commits.slice(start, start + 100);
        const variables = repositoryVariables(repo);
        const parameters = batch.map((commit, index) => {
          variables[`oid${index}`] = commit.oid;
          return `$oid${index}:GitObjectID!`;
        });
        const fields = batch.map(
          (_, index) =>
            `commit${index}:object(oid:$oid${index}){... on Commit{oid author{name email user{login __typename}}}}`,
        );
        const data = graphql(
          repo,
          `query($owner:String!,$name:String!,${parameters.join(",")}){repository(owner:$owner,name:$name){${fields.join(" ")}}}`,
          variables,
          route,
        ).repository;
        for (const [index, source] of batch.entries()) {
          const commit = data?.[`commit${index}`];
          if (commit?.oid !== source.oid) {
            throw invalidMetadata("Cannot establish the requested source commit author.");
          }
          const account = commit.author?.user;
          result.push(
            commitAuthor(
              commit.author,
              account === null ? null : { login: account?.login, type: account?.__typename },
              source.changesTree,
            ),
          );
        }
      }
      return result;
    },
  );
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
  if (route === "plain" && args[0] === "writer-login" && args.length <= 2) {
    process.stdout.write(`${writerLogin(args[1])}\n`);
    return;
  }
  if (args[0] === "repo-authority" && args.length === 3) {
    process.stdout.write(
      `${JSON.stringify(readRepoAuthority(namedRepository(args[1], args[2]), route))}\n`,
    );
    return;
  }
  if (args[0] === "issue-comments" && args.length === 4) {
    process.stdout.write(
      `${JSON.stringify(readIssueComments(namedRepository(args[1], args[2]), args[3], route))}\n`,
    );
    return;
  }
  if (args[0] === "author-permission" && args.length === 4) {
    process.stdout.write(
      `${JSON.stringify(readAuthorPermission(namedRepository(args[1], args[2]), args[3], route))}\n`,
    );
    return;
  }
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
      const record = readRepoAuthority(repo, route);
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

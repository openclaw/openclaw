import { execGhRead } from "./lib/plain-gh.mjs";

const PULL_REQUEST_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number
      url
      headRefName
      headRefOid
      baseRefName
      state
      isDraft
      title
      lastEditedAt
      titleEdits: timelineItems(last: 1, itemTypes: [RENAMED_TITLE_EVENT]) {
        nodes {
          ... on RenamedTitleEvent {
            createdAt
          }
        }
      }
      baseEdits: timelineItems(last: 1, itemTypes: [BASE_REF_CHANGED_EVENT]) {
        nodes {
          ... on BaseRefChangedEvent {
            createdAt
          }
        }
      }
      author {
        login
      }
    }
  }
}`;

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          isResolved
          comments(first: 100) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              fullDatabaseId
            }
          }
        }
      }
    }
  }
}`;

const REVIEW_THREAD_COMMENTS_QUERY = `query($threadId: ID!, $cursor: String!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $cursor) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          fullDatabaseId
        }
      }
    }
  }
}`;

const REQUIRED_CHECK_POLICY_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      baseRefName
      baseRef {
        branchProtectionRule {
          requiresStatusChecks
          requiredStatusCheckContexts
          requiredStatusChecks {
            context
            app {
              databaseId
            }
          }
        }
      }
    }
  }
}`;

function defaultReadGh(args) {
  return execGhRead(args, { encoding: "utf8" });
}

function parseJson(raw, label) {
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    throw new Error(`${label} returned invalid JSON`, { cause: error });
  }
}

function splitRepo(repo) {
  const match = String(repo).match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`invalid GitHub repository identity: ${repo}`);
  }
  return { owner: match[1], name: match[2] };
}

function flattenArrayPages(value, label) {
  if (!Array.isArray(value) || value.some((page) => !Array.isArray(page))) {
    throw new Error(`${label} returned an invalid paginated response`);
  }
  return value.flat();
}

function normalizeIntegrationId(value, label) {
  if (value == null) {
    return null;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} returned an invalid integration ID`);
  }
  return value;
}

function normalizeFullDatabaseId(value, label) {
  if (typeof value === "string" && /^[1-9]\d*$/u.test(value)) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  throw new Error(`${label} returned an invalid comment identity`);
}

function normalizePolicyCheckObservation(observation, headSha, requirement, index) {
  const source = observation.source;
  const raw = observation.raw;
  let status;
  let conclusion;
  if (source === "check_run") {
    status = String(raw?.status ?? "").toLowerCase();
    const rawConclusion = raw?.conclusion == null ? null : String(raw.conclusion).toLowerCase();
    if (!status) {
      throw new Error(`check run ${requirement.context} omitted status`);
    }
    if (status === "completed" && rawConclusion === null) {
      throw new Error(`completed check run ${requirement.context} omitted its conclusion`);
    }
    conclusion =
      status !== "completed"
        ? null
        : ["success", "neutral", "skipped"].includes(rawConclusion ?? "")
          ? "success"
          : rawConclusion;
  } else {
    const state = String(raw?.state ?? "").toLowerCase();
    if (!state || !["success", "failure", "error", "pending"].includes(state)) {
      throw new Error(`commit status ${requirement.context} has an unknown state`);
    }
    status = state === "pending" ? "in_progress" : "completed";
    conclusion = state === "pending" ? null : state === "success" ? "success" : "failure";
  }
  return {
    id: `${requirement.context}:${requirement.integrationId}:${source}:${String(raw?.id ?? index)}`,
    name: requirement.context,
    status: status === "completed" ? "completed" : "in_progress",
    conclusion,
    head_sha: headSha,
    html_url: String(raw?.html_url ?? raw?.details_url ?? raw?.target_url ?? ""),
    required: true,
  };
}

/**
 * Create the live, read-only GitHub evidence provider used by the advisory audit CLI.
 * @param {{ readGh?: (args: string[]) => string }} [options]
 */
export function createGhPrConvergenceProvider({ readGh = defaultReadGh } = {}) {
  const readJson = (args, label) => parseJson(readGh(args), label);
  const readArrayPages = (endpoint, label) =>
    flattenArrayPages(readJson(["api", "--paginate", "--slurp", endpoint], label), label);

  const readCheckRunPages = (endpoint, label) => {
    const pages = readJson(["api", "--paginate", "--slurp", endpoint], label);
    if (
      !Array.isArray(pages) ||
      pages.some((page) => !page || typeof page !== "object" || !Array.isArray(page.check_runs))
    ) {
      throw new Error(`${label} returned an invalid paginated response`);
    }
    return pages.flatMap((page) => page.check_runs);
  };

  const fetchReviewThreadResolution = (repo, pr) => {
    const { owner, name } = splitRepo(repo);
    const resolutionByCommentId = new Map();
    let cursor = null;
    do {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${REVIEW_THREADS_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${pr}`,
      ];
      if (cursor !== null) {
        args.push("-F", `cursor=${cursor}`);
      }
      const response = readJson(args, "review threads query");
      if (Array.isArray(response?.errors) && response.errors.length > 0) {
        throw new Error("review threads query returned GraphQL errors");
      }
      const threads = response?.data?.repository?.pullRequest?.reviewThreads;
      if (!threads || !Array.isArray(threads.nodes) || !threads.pageInfo) {
        throw new Error("review threads query returned an invalid response");
      }
      for (const thread of threads.nodes) {
        if (
          typeof thread?.id !== "string" ||
          !thread.id ||
          typeof thread?.isResolved !== "boolean" ||
          !Array.isArray(thread?.comments?.nodes) ||
          !thread.comments.pageInfo
        ) {
          throw new Error("review threads query returned an invalid thread");
        }
        const comments = [...thread.comments.nodes];
        let commentCursor =
          thread.comments.pageInfo.hasNextPage === true ? thread.comments.pageInfo.endCursor : null;
        if (
          thread.comments.pageInfo.hasNextPage === true &&
          (typeof commentCursor !== "string" || !commentCursor)
        ) {
          throw new Error("review thread comments omitted their next cursor");
        }
        while (commentCursor !== null) {
          const commentResponse = readJson(
            [
              "api",
              "graphql",
              "-f",
              `query=${REVIEW_THREAD_COMMENTS_QUERY}`,
              "-F",
              `threadId=${thread.id}`,
              "-F",
              `cursor=${commentCursor}`,
            ],
            "review thread comments query",
          );
          if (Array.isArray(commentResponse?.errors) && commentResponse.errors.length > 0) {
            throw new Error("review thread comments query returned GraphQL errors");
          }
          const commentPage = commentResponse?.data?.node?.comments;
          if (!commentPage || !Array.isArray(commentPage.nodes) || !commentPage.pageInfo) {
            throw new Error("review thread comments query returned an invalid response");
          }
          comments.push(...commentPage.nodes);
          const hasNextCommentPage = commentPage.pageInfo.hasNextPage === true;
          commentCursor = hasNextCommentPage ? commentPage.pageInfo.endCursor : null;
          if (hasNextCommentPage && (typeof commentCursor !== "string" || !commentCursor)) {
            throw new Error("review thread comments query omitted its next cursor");
          }
        }
        for (const comment of comments) {
          const commentId = normalizeFullDatabaseId(
            comment?.fullDatabaseId,
            "review threads query",
          );
          resolutionByCommentId.set(commentId, thread.isResolved);
        }
      }
      const hasNextPage = threads.pageInfo.hasNextPage === true;
      cursor = hasNextPage ? threads.pageInfo.endCursor : null;
      if (hasNextPage && (typeof cursor !== "string" || !cursor)) {
        throw new Error("review threads query omitted its next cursor");
      }
    } while (cursor !== null);
    return resolutionByCommentId;
  };

  const resolveRequiredCheckPolicy = (repo, pr) => {
    const { owner, name } = splitRepo(repo);
    const response = readJson(
      [
        "api",
        "graphql",
        "-f",
        `query=${REQUIRED_CHECK_POLICY_QUERY}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${pr}`,
      ],
      "required-check policy query",
    );
    if (Array.isArray(response?.errors) && response.errors.length > 0) {
      throw new Error("required-check policy query returned GraphQL errors");
    }
    const pull = response?.data?.repository?.pullRequest;
    const baseRefName = pull?.baseRefName;
    if (typeof baseRefName !== "string" || !baseRefName) {
      throw new Error("required-check policy query omitted the PR base branch");
    }

    const requirements = new Map();
    const addRequirement = (context, integrationId) => {
      if (typeof context !== "string" || !context) {
        throw new Error("required-check policy returned an invalid context");
      }
      const normalizedIntegrationId = normalizeIntegrationId(
        integrationId,
        `required check ${context}`,
      );
      requirements.set(`${context}\0${normalizedIntegrationId ?? "any"}`, {
        context,
        integrationId: normalizedIntegrationId,
      });
    };
    const branchProtection = pull?.baseRef?.branchProtectionRule;
    if (branchProtection?.requiresStatusChecks === true) {
      const statusChecks = branchProtection.requiredStatusChecks;
      const statusCheckContexts = branchProtection.requiredStatusCheckContexts;
      if (!Array.isArray(statusChecks) || !Array.isArray(statusCheckContexts)) {
        throw new Error("branch protection omitted required-check policy fields");
      }
      if (statusChecks.length > 0) {
        for (const check of statusChecks) {
          addRequirement(check?.context, check?.app?.databaseId);
        }
      } else {
        for (const context of statusCheckContexts) {
          addRequirement(context, null);
        }
      }
    }

    const rules = readArrayPages(
      `repos/${repo}/rules/branches/${encodeURIComponent(baseRefName)}`,
      "base-branch rules",
    );
    for (const rule of rules) {
      const type = String(rule?.type ?? "");
      if (type === "workflows" || type === "required_workflows") {
        throw new Error("required workflow policy cannot be resolved completely");
      }
      if (type !== "required_status_checks") {
        continue;
      }
      const requiredChecks = rule?.parameters?.required_status_checks;
      if (!Array.isArray(requiredChecks)) {
        throw new Error("ruleset returned invalid required status checks");
      }
      for (const check of requiredChecks) {
        addRequirement(check?.context, check?.integration_id);
      }
    }
    return [...requirements.values()];
  };

  return {
    async fetchPullRequest({ repo, pr }) {
      const { owner, name } = splitRepo(repo);
      const response = readJson(
        [
          "api",
          "graphql",
          "-f",
          `query=${PULL_REQUEST_QUERY}`,
          "-F",
          `owner=${owner}`,
          "-F",
          `name=${name}`,
          "-F",
          `number=${pr}`,
        ],
        "pull request identity query",
      );
      if (Array.isArray(response?.errors) && response.errors.length > 0) {
        throw new Error("pull request identity query returned GraphQL errors");
      }
      const pull = response?.data?.repository?.pullRequest;
      if (!pull) {
        throw new Error(`pull request #${pr} was not found in ${repo}`);
      }
      /** @type {{
       *   number: number;
       *   html_url: string;
       *   head: { sha: string; ref: string };
       *   base: { ref: string };
       *   state: string;
       *   draft: boolean;
       *   last_edited_at: string | null;
       *   title_edited_at: string | null;
       *   base_edited_at: string | null;
       *   user?: { login: string };
       * }} */
      const normalizedPull = {
        number: pull.number,
        html_url: pull.url,
        head: { sha: pull.headRefOid, ref: pull.headRefName },
        base: { ref: pull.baseRefName },
        state: String(pull.state ?? ""),
        draft: pull.isDraft === true,
        title: String(pull.title ?? ""),
        last_edited_at: pull.lastEditedAt ?? null,
        title_edited_at: pull.titleEdits?.nodes?.[0]?.createdAt ?? null,
        base_edited_at: pull.baseEdits?.nodes?.[0]?.createdAt ?? null,
        user: { login: pull.author?.login ?? "" },
      };
      return normalizedPull;
    },

    async fetchFormalReviews({ repo, pr }) {
      return {
        items: readArrayPages(`repos/${repo}/pulls/${pr}/reviews?per_page=100`, "formal reviews"),
        complete: true,
      };
    },

    async fetchInlineReviewComments({ repo, pr }) {
      const items = readArrayPages(
        `repos/${repo}/pulls/${pr}/comments?per_page=100`,
        "inline review comments",
      );
      const resolutionByCommentId = fetchReviewThreadResolution(repo, pr);
      for (const item of items) {
        const id = String(item?.id ?? "");
        if (!id || !resolutionByCommentId.has(id)) {
          throw new Error(`inline review comment ${id || "<missing>"} has no review thread`);
        }
        item.thread_resolved = resolutionByCommentId.get(id);
      }
      return {
        items,
        complete: true,
      };
    },

    async fetchIssueComments({ repo, pr }) {
      return {
        items: readArrayPages(`repos/${repo}/issues/${pr}/comments?per_page=100`, "issue comments"),
        complete: true,
      };
    },

    async fetchRequestedReviewers({ repo, pr }) {
      const pages = readJson(
        [
          "api",
          "--paginate",
          "--slurp",
          `repos/${repo}/pulls/${pr}/requested_reviewers?per_page=100`,
        ],
        "requested reviewers",
      );
      if (!Array.isArray(pages) || pages.some((page) => page == null || typeof page !== "object")) {
        throw new Error("requested reviewers returned an invalid paginated response");
      }
      const logins = [];
      for (const page of pages) {
        if (Array.isArray(page.users)) {
          logins.push(...page.users.map((user) => user?.login));
        }
        if (Array.isArray(page.teams)) {
          logins.push(...page.teams.map((team) => team?.slug));
        }
      }
      if (logins.some((login) => typeof login !== "string" || !login)) {
        throw new Error("requested reviewers returned an invalid actor identity");
      }
      return { logins, complete: true };
    },

    async fetchCheckRuns({ repo, pr, headSha }) {
      let requirements;
      try {
        requirements = resolveRequiredCheckPolicy(repo, pr);
      } catch {
        return { items: [], complete: true, requiredPolicy: "unknown" };
      }
      if (requirements.length === 0) {
        return { items: [], complete: true, requiredPolicy: "resolved" };
      }

      let exactHeadCheckRuns;
      let exactHeadStatuses;
      try {
        exactHeadCheckRuns = readCheckRunPages(
          `repos/${repo}/commits/${headSha}/check-runs?filter=latest&per_page=100`,
          "exact-head check runs",
        );
        exactHeadStatuses = readArrayPages(
          `repos/${repo}/commits/${headSha}/statuses?per_page=100`,
          "exact-head commit statuses",
        );
      } catch {
        return { items: [], complete: true, requiredPolicy: "unknown" };
      }

      const normalized = [];
      const appIdBySlug = new Map();
      const resolveStatusIntegrationId = (status) => {
        const login = String(status?.creator?.login ?? "");
        const match = login.match(/^(.+)\[bot\]$/i);
        if (!match) {
          return null;
        }
        const slug = match[1];
        if (!appIdBySlug.has(slug)) {
          const app = readJson(["api", `apps/${encodeURIComponent(slug)}`], `GitHub App ${slug}`);
          appIdBySlug.set(slug, normalizeIntegrationId(app?.id, `GitHub App ${slug}`));
        }
        return appIdBySlug.get(slug);
      };

      try {
        for (const requirement of requirements) {
          const checkRunObservations = exactHeadCheckRuns
            .filter(
              (checkRun) =>
                checkRun?.name === requirement.context &&
                (requirement.integrationId === null ||
                  checkRun?.app?.id === requirement.integrationId),
            )
            .map((checkRun) => ({ source: "check_run", raw: checkRun }));
          // GitHub guarantees newest-first ordering for commit statuses. Preserve
          // that ordering so same-second updates are resolved by API position.
          // Select the newest context first: an unexpected source must not expose
          // an older success from the app required by branch protection.
          const latestContextStatus = exactHeadStatuses.find(
            (status) =>
              String(status?.context ?? "").toLowerCase() === requirement.context.toLowerCase(),
          );
          const latestStatusIntegrationId =
            latestContextStatus && requirement.integrationId !== null
              ? resolveStatusIntegrationId(latestContextStatus)
              : null;
          const statusSourceMismatch =
            latestContextStatus !== undefined &&
            requirement.integrationId !== null &&
            latestStatusIntegrationId !== requirement.integrationId;
          const statusObservation =
            latestContextStatus &&
            (requirement.integrationId === null ||
              latestStatusIntegrationId === requirement.integrationId)
              ? [{ source: "commit_status", raw: latestContextStatus }]
              : [];
          const observations = [...checkRunObservations, ...statusObservation];
          if (statusSourceMismatch) {
            normalized.push({
              id: `${requirement.context}:${requirement.integrationId}:commit_status:unexpected-source`,
              name: requirement.context,
              status: "queued",
              conclusion: null,
              head_sha: headSha,
              html_url: String(latestContextStatus?.target_url ?? ""),
              required: true,
            });
          }
          if (observations.length === 0) {
            if (!statusSourceMismatch) {
              normalized.push({
                id: `${requirement.context}:${requirement.integrationId ?? "any"}:missing`,
                name: requirement.context,
                status: "queued",
                conclusion: null,
                head_sha: headSha,
                html_url: "",
                required: true,
              });
            }
            continue;
          }
          normalized.push(
            ...observations.map((observation, index) =>
              normalizePolicyCheckObservation(observation, headSha, requirement, index),
            ),
          );
        }
      } catch {
        return { items: [], complete: true, requiredPolicy: "unknown" };
      }
      return { items: normalized, complete: true, requiredPolicy: "resolved" };
    },
  };
}

/** @param {{ readGh?: (args: string[]) => string }} [options] */
export function resolveCurrentGitHubRepo({ readGh = defaultReadGh } = {}) {
  const repo = readGh(["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  splitRepo(repo);
  return repo;
}

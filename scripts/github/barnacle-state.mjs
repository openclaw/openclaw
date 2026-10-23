// Canonical GitHub facts and immutable identities shared by Barnacle decision owners.
export const BARNACLE = new Map([
  [257215752, 2729701],
  [264559031, 2971289],
]);
const CLAWSWEEPER = 274271284;
const PROTECTED = new Set([
  "maintainer",
  "pinned",
  "hold",
  "in-progress",
  "clawsweeper:queueable-fix",
  "clawsweeper:source-repro",
  "clawsweeper:fix-shape-clear",
  "no-stale",
  "bad-barnacle",
  "p0",
  "p1",
  "status: 👀 ready for maintainer look",
  "security",
  "impact:security",
  "clawsweeper:needs-security-review",
  "security-review-required",
  "security-sensitive-changed",
  "merge-risk: 🚨 security-boundary",
]);
const ROLES = new Set(["admin", "maintain", "write"]);
const ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
// REST timeline names: https://docs.github.com/en/rest/using-the-rest-api/issue-event-types.
const ACTIVITY_EVENTS = new Set([
  "renamed",
  "reopened",
  "convert_to_draft",
  "ready_for_review",
  "review_requested",
  "review_dismissed",
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "base_ref_changed",
]);
const HEAD_EVENTS = new Set(["head_ref_force_pushed", "head_ref_deleted", "base_ref_force_pushed"]);
export function humanActivityAt(snapshot, ignoredComment) {
  let latest = time(snapshot.pr.created_at);
  for (const comment of [...snapshot.comments, ...snapshot.reviewComments, ...snapshot.reviews]) {
    if (comment.id !== ignoredComment && !automated(comment.user ?? comment.author)) {
      latest = Math.max(
        latest,
        time(comment.submitted_at ?? comment.submittedAt),
        time(comment.created_at ?? comment.createdAt),
      );
    }
  }
  for (const edit of snapshot.edits ?? []) {
    if (!automated(edit.editor)) {
      latest = Math.max(latest, time(edit.editedAt));
    }
  }
  for (const event of snapshot.timeline) {
    if (
      HEAD_EVENTS.has(event.event) ||
      (ACTIVITY_EVENTS.has(event.event) && !automated(event.actor))
    ) {
      latest = Math.max(latest, time(event.created_at));
    }
  }
  return latest;
}
export const time = (value) => Date.parse(value ?? "") || 0;
export const automated = (user) =>
  user?.type === "Bot" ||
  user?.__typename === "Bot" ||
  BARNACLE.has(user?.id) ||
  user?.id === CLAWSWEEPER;
export const trustedBarnacle = (comment) =>
  BARNACLE.has(comment.user?.id) &&
  BARNACLE.get(comment.user.id) === comment.performed_via_github_app?.id;
export const verifiedComment = (comment, body, expectedAppId, existing = false) =>
  comment?.body === body &&
  comment.created_at === comment.updated_at &&
  trustedBarnacle(comment) &&
  (existing || comment.performed_via_github_app.id === expectedAppId);
export const labelsOf = (pr) =>
  (pr.labels ?? []).map((label) => (typeof label === "string" ? label : label.name).toLowerCase());
export function cheapProtection(pr) {
  if (pr.state !== "open" || pr.merged || pr.locked) {
    return "closed-or-merged";
  }
  if (labelsOf(pr).some((label) => PROTECTED.has(label))) {
    return "protected-label";
  }
  if (!pr.head && labelsOf(pr).includes("enhancement")) {
    return "protected-label";
  }
  if (ASSOCIATIONS.has(pr.author_association)) {
    return "maintainer-author";
  }
  return null;
}

// updated_at includes our own writes and review bots. Compare the actual
// admission facts; human content edits are separately verified by the snapshot.
export function admissionKey(item) {
  return JSON.stringify([
    item.state,
    item.merged,
    Boolean(item.locked),
    item.title,
    item.body,
    item.user?.id,
    item.author_association,
    item.head?.sha,
    labelsOf(item).toSorted(),
    (item.assignees ?? []).map((user) => user.id ?? user.login).toSorted(),
  ]);
}

export async function freshTarget(github, context, number) {
  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  if (!issue.pull_request) {
    return issue;
  }
  const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
  return { ...pr, locked: issue.locked, closed_by: issue.closed_by };
}

export async function ownershipProtection(io, item) {
  for (const user of [item.user, ...(item.assignees ?? [])]) {
    if (!user?.login) {
      return "unknown-ownership";
    }
    try {
      const { data } = await io.call(io.github.rest.repos.getCollaboratorPermissionLevel, {
        username: user.login,
      });
      if (ROLES.has(data.permission) || ROLES.has(data.role_name)) {
        return "maintainer-ownership";
      }
    } catch (error) {
      if (error.status === 403 || error.status === 404) {
        return "unknown-ownership";
      }
      throw error;
    }
  }
  return null;
}

export function securityProtection(comments, pr) {
  for (const comment of comments) {
    if (comment.user?.id !== CLAWSWEEPER || comment.performed_via_github_app?.id !== 3306130) {
      continue;
    }
    // Human text is explanatory; only the review owner's exact-head markers are authority.
    for (const marker of comment.body.matchAll(
      /<!--\s*clawsweeper-(security|verdict|review-state):([a-z-]+)([\s\S]*?)-->/g,
    )) {
      if (marker[1] !== "security" || marker[2] !== "security-sensitive") {
        continue;
      }
      const item = /\bitem=(\d+)\b/.exec(marker[3]);
      const sha = /\bsha=([0-9a-f]{40})\b/.exec(marker[3]);
      if (!item || !sha) {
        return "unknown-security-marker";
      }
      if (Number(item[1]) !== pr.number) {
        continue;
      }
      return sha[1] === pr.head?.sha ? "security-review-required" : "unknown-security-head";
    }
  }
  return null;
}

export function reader(github, checksGithub, context, budget) {
  let requests = 0;
  const usage = { app: 0, checks: 0, graphql: 0 };
  const quotas = {};
  const exhausted = (reason) =>
    Object.assign(
      new Error(
        `Stale PR API budget exhausted: ${reason}; checkpoint includes only completed decisions`,
      ),
      { code: "STALE_PR_BUDGET" },
    );
  const reserve = (needed) => {
    const total = Object.values(needed).reduce((sum, count) => sum + count, 0);
    if (requests + total > budget) {
      throw exhausted(`${requests}/${budget}, need ${total}`);
    }
    for (const [lane, count] of Object.entries(needed)) {
      if (quotas[lane] && quotas[lane].remaining < count + 10) {
        throw exhausted(`${lane} remaining=${quotas[lane].remaining}, reset=${quotas[lane].reset}`);
      }
    }
  };
  const take = (lane) => {
    reserve({ [lane]: 1 });
    requests++;
    usage[lane]++;
    if (quotas[lane]) {
      quotas[lane].remaining--;
    }
  };
  const update = (lane, remaining, reset) => {
    if (!Number.isFinite(Number(remaining))) {
      return;
    }
    const previous = quotas[lane];
    quotas[lane] = {
      remaining: previous ? Math.min(previous.remaining, Number(remaining)) : Number(remaining),
      reset,
    };
  };
  const call = async (method, params, lane = "app") => {
    take(lane);
    const response = await method({ ...context.repo, ...params });
    update(
      lane,
      response.headers?.["x-ratelimit-remaining"],
      response.headers?.["x-ratelimit-reset"],
    );
    return response;
  };
  const init = async () => {
    const results = await Promise.allSettled([
      call(github.rest.rateLimit.get, {}),
      call(checksGithub.rest.rateLimit.get, {}, "checks"),
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure) {
      throw failure.reason;
    }
    const [app, checks] = results.map((result) => result.value.data.resources);
    for (const [lane, resource] of [
      ["app", app.core],
      ["checks", checks.core],
      ["graphql", checks.graphql],
    ]) {
      if (!resource || !Number.isFinite(resource.remaining)) {
        throw new Error(`Missing ${lane} quota evidence`);
      }
      quotas[lane] = { remaining: resource.remaining, reset: resource.reset };
    }
  };
  const pages = async (method, params, key, lane = "app") => {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const { data } = await call(method, { ...params, per_page: 100, page }, lane);
      if (key === "workflow_runs" && data.total_count > 1000) {
        const error = new Error("Filtered workflow history exceeds GitHub's 1000-run limit");
        error.code = "STALE_PR_HISTORY";
        throw error;
      }
      const batch = key ? data[key] : data;
      rows.push(...batch);
      if (batch.length < 100) {
        return rows;
      }
    }
    throw new Error("Stale PR pagination incomplete after 100 pages; checkpoint unchanged");
  };
  const graphql = async (query, variables) => {
    take("graphql");
    const response = await checksGithub.graphql(query, { ...context.repo, ...variables });
    if (!response.rateLimit || !Number.isSafeInteger(response.rateLimit.cost)) {
      throw new Error("Missing GraphQL quota evidence");
    }
    usage.graphql += Math.max(0, response.rateLimit.cost - 1);
    update("graphql", response.rateLimit.remaining, response.rateLimit.resetAt);
    return response;
  };
  return {
    github,
    call,
    pages,
    graphql,
    reserve,
    init,
    count: () => requests,
    usage: () => ({ ...usage }),
    quotas: () => structuredClone(quotas),
  };
}

async function contentEdits(io, contents) {
  const edits = [];
  const fields = `id ...on Comment{lastEditedAt userContentEdits(first:100,after:$after){totalCount nodes{id editedAt editor{__typename ...on User{id:databaseId} ...on Bot{id:databaseId}}} pageInfo{hasNextPage endCursor}}}`;
  let protection = null;
  const collect = async (content, initial) => {
    let node = initial;
    let latest = 0;
    let count = 0;
    const seen = new Set();
    for (let page = 0; page < 100; page++) {
      const history = node?.userContentEdits;
      if (node?.id !== content.nodeId || !history?.nodes || !history.pageInfo) {
        protection = "unknown-edit-history";
        return;
      }
      for (const edit of history.nodes) {
        if (
          !time(edit?.editedAt) ||
          !edit.id ||
          seen.has(edit.id) ||
          !Number.isSafeInteger(edit.editor?.id) ||
          edit.editor.id <= 0
        ) {
          protection = "unknown-edit-identity";
          return;
        }
        latest = Math.max(latest, time(edit.editedAt));
        count++;
        seen.add(edit.id);
        edits.push({ ...edit, commentId: content.commentId });
      }
      if (!history.pageInfo.hasNextPage) {
        if (
          count !== history.totalCount ||
          (node.lastEditedAt && latest !== time(node.lastEditedAt))
        ) {
          protection = "incomplete-edit-history";
        }
        return;
      }
      if (!history.pageInfo.endCursor) {
        break;
      }
      const response = await io.graphql(
        `query($id:ID!,$after:String){rateLimit{remaining resetAt cost} node(id:$id){${fields}}}`,
        { id: content.nodeId, after: history.pageInfo.endCursor },
      );
      node = response.node;
    }
    protection = "incomplete-edit-history";
  };
  // Bot comments need history even when REST timestamps match: a human can edit
  // within the creation second. Human creation already covers that same instant.
  for (let offset = 0; offset < contents.length; offset += 25) {
    const batch = contents.slice(offset, offset + 25);
    if (batch.some((content) => !content.nodeId)) {
      return { edits, activityProtection: "unknown-edit-history" };
    }
    const response = await io.graphql(
      `query($ids:[ID!]!,$after:String){rateLimit{remaining resetAt cost} nodes(ids:$ids){${fields}}}`,
      { ids: batch.map((content) => content.nodeId), after: null },
    );
    for (const content of batch) {
      await collect(
        content,
        response.nodes?.find((node) => node?.id === content.nodeId),
      );
    }
  }
  return { edits, activityProtection: protection };
}

export async function snapshotOf(
  github,
  checksGithub,
  io,
  number,
  kind = "pull-request",
  inspectChecks = true,
) {
  const get = () =>
    io.call(
      kind === "issue" ? github.rest.issues.get : github.rest.pulls.get,
      kind === "issue" ? { issue_number: number } : { pull_number: number },
    );
  const { data: pr } = await get();
  const base = { issue_number: number };
  const observations = await Promise.allSettled([
    io.pages(github.rest.issues.listComments, base),
    kind === "issue" ? [] : io.pages(github.rest.pulls.listReviewComments, { pull_number: number }),
    io.pages(github.rest.issues.listEventsForTimeline, base),
    kind === "issue" || !inspectChecks
      ? []
      : io.pages(
          checksGithub.rest.checks.listForRef,
          { ref: pr.head.sha, filter: "latest" },
          "check_runs",
          "checks",
        ),
    kind === "issue" || !inspectChecks
      ? []
      : io.pages(
          github.rest.actions.listWorkflowRunsForRepo,
          { head_sha: pr.head.sha },
          "workflow_runs",
        ),
    kind === "issue" || !inspectChecks
      ? []
      : io.pages(github.rest.repos.listCommitStatusesForRef, { ref: pr.head.sha }),
  ]);
  const failure = observations.find(
    (item) => item.status === "rejected" && item.reason.code !== "STALE_PR_HISTORY",
  );
  if (failure) {
    throw failure.reason;
  }
  const historyProtection = observations.some((item) => item.status === "rejected")
    ? "incomplete-workflow-history"
    : null;
  const [comments, reviewComments, timeline, runs, workflowRuns, statuses] = observations.map(
    (item) => (item.status === "fulfilled" ? item.value : []),
  );
  let after = null;
  const reviews = [];
  let meta;
  let checkRollup;
  if (kind === "issue") {
    const response = await io.graphql(
      `query($owner:String!,$repo:String!,$number:Int!){rateLimit{remaining resetAt cost} repository(owner:$owner,name:$repo){issue(number:$number){id lastEditedAt}}}`,
      { number },
    );
    meta = response.repository.issue;
  } else {
    const cursors = new Set();
    let reviewPages = 0;
    do {
      if (++reviewPages > 100 || cursors.has(after)) {
        throw new Error("Incomplete review pagination");
      }
      cursors.add(after);
      const response = await io.graphql(
        `query($owner:String!,$repo:String!,$number:Int!,${inspectChecks ? "$head:GitObjectID!," : ""}$after:String){rateLimit{remaining resetAt cost} repository(owner:$owner,name:$repo){${inspectChecks ? "object(oid:$head){...on Commit{oid statusCheckRollup{state}}}" : ""} pullRequest(number:$number){id lastEditedAt reviews(first:100,after:$after){nodes{id databaseId:fullDatabaseId submittedAt lastEditedAt commit{oid} author{__typename ...on User{id:databaseId} ...on Bot{id:databaseId}}} pageInfo{hasNextPage endCursor}}}}}`,
        { number, ...(inspectChecks ? { head: pr.head.sha } : {}), after },
      );
      checkRollup =
        response.repository.object?.oid === pr.head.sha
          ? response.repository.object.statusCheckRollup?.state
          : null;
      meta = response.repository.pullRequest;
      if (
        !meta?.reviews?.nodes ||
        !meta.reviews.pageInfo ||
        (meta.reviews.pageInfo.hasNextPage && !meta.reviews.pageInfo.endCursor)
      ) {
        throw new Error("Incomplete review history");
      }
      reviews.push(
        ...meta.reviews.nodes.map((review) => ({
          ...review,
          node_id: review.id,
          id: Number(review.databaseId),
          commit_id: review.commit?.oid,
        })),
      );
      after = meta.reviews.pageInfo.hasNextPage ? meta.reviews.pageInfo.endCursor : null;
    } while (after);
  }
  if (!meta?.id) {
    throw new Error("Missing content identity");
  }
  const editHistory = await contentEdits(io, [
    ...(meta.lastEditedAt ? [{ nodeId: meta.id }] : []),
    ...[...comments, ...reviewComments]
      .filter((comment) => automated(comment.user) || comment.updated_at !== comment.created_at)
      .map((comment) => ({ nodeId: comment.node_id, commentId: comment.id })),
    ...reviews
      .filter((review) => review.lastEditedAt)
      .map((review) => ({ nodeId: review.node_id })),
  ]);
  const ownerProtection = await ownershipProtection(io, pr);
  if (
    [...comments, ...reviewComments, ...reviews].some(
      (comment) => !Number.isSafeInteger((comment.user ?? comment.author)?.id),
    ) ||
    timeline.some(
      (event) => ACTIVITY_EVENTS.has(event.event) && !Number.isSafeInteger(event.actor?.id),
    )
  ) {
    editHistory.activityProtection = "unknown-activity-identity";
  }
  const { data: observed } = await get();
  const unstable =
    observed.updated_at !== pr.updated_at ||
    observed.head?.sha !== pr.head?.sha ||
    admissionKey(observed) !== admissionKey(pr);
  return {
    pr,
    kind,
    comments,
    reviewComments,
    reviews,
    timeline,
    runs,
    workflowRuns,
    statuses,
    checkRollup,
    ownershipProtection: ownerProtection,
    historyProtection,
    unstable,
    ...editHistory,
  };
}

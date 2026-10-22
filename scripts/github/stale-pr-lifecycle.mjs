// Barnacle owns PR inactivity. GitHub updated_at also changes when review bots work.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const DAY = 86_400_000;
const BARNACLE = new Map([
  [257215752, 2729701],
  [264559031, 2971289],
]);
const CLAWSWEEPER = 274271284;
const PROTECTED = new Set([
  "maintainer",
  "no-stale",
  "bad-barnacle",
  "p0",
  "p1",
  "status: 👀 ready for maintainer look",
  "security",
  "security-review-required",
  "security-sensitive-changed",
  "merge-risk: 🚨 security-boundary",
]);
const CI_GATES = new Set(["openclaw/ci-gate", "CI gate", "ci-gate"]);
const PRODUCT_CHECKS = new Set(["checks-node-core", "check", "build-smoke", "build-artifacts"]);
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
const WARN =
  "This pull request has been automatically marked as stale due to inactivity.\nPlease add updates or it will be closed.";
const ASSIGNED_WARN =
  "This assigned pull request has been automatically marked as stale after being open for 27 days.\nPlease add updates or it will be closed.";
export const closeMessage =
  "Closing due to inactivity.\nIf you believe this PR should be revived, post in #clawtributors on Discord to talk to a maintainer.\nThat channel is the escape hatch for high-quality PRs that get auto-closed.\n";
const time = (value) => Date.parse(value ?? "") || 0;
const automated = (user) =>
  user?.type === "Bot" ||
  user?.__typename === "Bot" ||
  BARNACLE.has(user?.id) ||
  user?.id === CLAWSWEEPER;
const trustedBarnacle = (comment) =>
  BARNACLE.has(comment.user?.id) &&
  BARNACLE.get(comment.user.id) === comment.performed_via_github_app?.id;
const labelsOf = (pr) =>
  (pr.labels ?? []).map((label) => (typeof label === "string" ? label : label.name).toLowerCase());
const isWarning = (comment) =>
  [WARN, ASSIGNED_WARN].includes(comment.body.split("\n\n<!-- barnacle-stale-pr:v1")[0].trimEnd());
const warningHead = (comment) =>
  /<!-- barnacle-stale-pr:v1 head=([0-9a-f]{40}) -->/.exec(comment.body)?.[1];

function cheapProtection(pr) {
  if (pr.state !== "open" || pr.merged) {
    return "closed-or-merged";
  }
  if (labelsOf(pr).some((label) => PROTECTED.has(label))) {
    return "protected-label";
  }
  if (ASSOCIATIONS.has(pr.author_association)) {
    return "maintainer-author";
  }
  return null;
}

function securityProtection(comments, pr) {
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
      return sha[1] === pr.head.sha ? "security-review-required" : "unknown-security-head";
    }
  }
  return null;
}

function latestWarning(snapshot) {
  return snapshot.comments
    .filter((comment) => trustedBarnacle(comment) && isWarning(comment))
    .toSorted((a, b) => time(b.created_at) - time(a.created_at) || b.id - a.id)[0];
}

const warningWasEdited = (snapshot, comment) =>
  comment.created_at !== comment.updated_at ||
  snapshot.edits?.some((edit) => edit.commentId === comment.id);

function headWitnesses(snapshot) {
  const { pr } = snapshot;
  const sourceKnown =
    Number.isSafeInteger(pr.head.repo?.id) &&
    pr.head.repo.id > 0 &&
    typeof pr.head.ref === "string" &&
    pr.head.ref.length > 0;
  const runs = (snapshot.workflowRuns ?? []).filter(
    (run) =>
      sourceKnown &&
      ["pull_request", "pull_request_target"].includes(run.event) &&
      run.head_sha === pr.head.sha &&
      run.head_repository?.id === pr.head.repo?.id &&
      run.head_branch === pr.head.ref &&
      time(run.created_at) >= time(pr.created_at),
  );
  const reviews = snapshot.reviews.filter(
    (review) => review.commit_id === pr.head.sha && time(review.submitted_at ?? review.submittedAt),
  );
  return [
    ...snapshot.comments
      .filter(
        (comment) =>
          trustedBarnacle(comment) &&
          isWarning(comment) &&
          !warningWasEdited(snapshot, comment) &&
          warningHead(comment) === pr.head.sha,
      )
      .map((comment) => ({ at: time(comment.created_at), source: "warning-head" })),
    ...runs.map((run) => ({ at: time(run.created_at), source: `workflow-run:${run.id}` })),
    ...reviews.map((review) => ({
      at: time(review.submitted_at ?? review.submittedAt),
      source: `review:${review.id}`,
    })),
  ];
}

function activityAt(snapshot, ignoredComment) {
  let latest = time(snapshot.pr.created_at);
  const witnesses = headWitnesses(snapshot);
  const earliest = witnesses.toSorted((a, b) => a.at - b.at)[0];
  // A bound warning records already-validated inactivity, not a new push. Later
  // bot reviews cannot restart either that admission clock or its seven-day grace.
  if (earliest && earliest.source !== "warning-head") {
    latest = Math.max(latest, earliest.at);
  }
  for (const comment of [...snapshot.comments, ...snapshot.reviewComments, ...snapshot.reviews]) {
    if (comment.id === ignoredComment || automated(comment.user ?? comment.author)) {
      continue;
    }
    latest = Math.max(
      latest,
      time(comment.submitted_at ?? comment.submittedAt),
      time(comment.created_at ?? comment.createdAt),
    );
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

/** Evaluate only authoritative GitHub facts; never use the PR's raw updated_at. */
export function evaluatePullRequest(snapshot, now = Date.now(), ignoredComment = null) {
  const { pr, comments, runs } = snapshot;
  const head = pr.head.sha;
  const result = (action, reason, extra = {}) => ({
    number: pr.number,
    head,
    action,
    reason,
    ...extra,
  });
  if (snapshot.unstable) {
    return result("preserve", "changed-during-observation");
  }
  const protectedReason =
    cheapProtection(pr) ||
    snapshot.ownershipProtection ||
    securityProtection(comments, pr) ||
    snapshot.historyProtection ||
    snapshot.activityProtection;
  if (protectedReason) {
    return result("preserve", protectedReason);
  }
  const latestStatuses = new Map();
  for (const status of snapshot.statuses ?? []) {
    if (!latestStatuses.has(status.context)) {
      latestStatuses.set(status.context, status);
    }
  }
  if (
    [...latestStatuses.values()].some(
      (status) => CI_GATES.has(status.context) && status.state === "success",
    )
  ) {
    return result("preserve", "executed-ci-proof");
  }
  // A named exact-head gate can be green while old, unrelated checks leave the rollup red.
  if (
    runs.some(
      (run) =>
        run.head_sha === head &&
        run.status === "completed" &&
        run.conclusion === "success" &&
        (CI_GATES.has(run.name) ||
          (snapshot.checkRollup === "SUCCESS" && PRODUCT_CHECKS.has(run.name))),
    )
  ) {
    return result("preserve", "executed-ci-proof");
  }
  const warning = latestWarning(snapshot);
  const witnesses = headWitnesses(snapshot);
  const ownClose =
    warning &&
    comments.findLast(
      (comment) =>
        trustedBarnacle(comment) &&
        comment.body === closeMessage &&
        time(comment.created_at) >= time(warning.created_at),
    );
  const activity = activityAt(snapshot, ignoredComment ?? ownClose?.id);
  const assigned = pr.assignees.length > 0;
  const eligibleAt = assigned ? time(pr.created_at) + 27 * DAY : activity + 14 * DAY;
  if (!warning) {
    if (!assigned && !witnesses.length) {
      return result("preserve", "unknown-head-timing");
    }
    if (now < eligibleAt) {
      return result("preserve", "initial-inactivity", {
        eligibleAt: new Date(eligibleAt).toISOString(),
      });
    }
    return result("warn", "initial-warning");
  }
  const warningAt = time(warning.created_at);
  if (activity >= warningAt && !assigned && now < eligibleAt) {
    return result(
      labelsOf(pr).includes("stale") ? "unmark" : "preserve",
      "human-or-head-activity",
      { eligibleAt: new Date(eligibleAt).toISOString() },
    );
  }
  if (warningWasEdited(snapshot, warning)) {
    return result(
      witnesses.length || assigned ? "warn" : "preserve",
      witnesses.length || assigned ? "edited-warning" : "unknown-head-timing",
    );
  }
  const marker = warningHead(warning);
  let witness = marker === head ? "warning-head" : null;
  if (marker && marker !== head) {
    return result(
      witnesses.length ? "warn" : "preserve",
      witnesses.length ? "head-changed" : "unknown-head-timing",
    );
  }
  if (!marker) {
    // Fork PR association arrays can be empty. The immutable workflow run must
    // bind the PR's source repository, branch and head after this PR was opened.
    witness = witnesses.find((item) => item.at <= warningAt)?.source;
  }
  if (!witness) {
    return result("preserve", "unknown-legacy-head");
  }
  if (activity >= warningAt) {
    return result("warn", "activity-after-warning");
  }
  const closeAt = Math.max(warningAt + 7 * DAY, assigned ? time(pr.created_at) + 34 * DAY : 0);
  if (now < closeAt) {
    return result("preserve", "warning-grace", {
      warning: warning.id,
      witness,
      eligibleAt: new Date(closeAt).toISOString(),
    });
  }
  return result("close", "expired-warning", {
    warning: warning.id,
    witness,
    closeComment: ownClose?.id,
  });
}

/** Identity checkpoints survive earlier PR closures; a complete cycle revisits reopened PRs. */
export function selectScanSlice(items, checkpoint, limit) {
  const ordered = items.toSorted((a, b) => a.number - b.number);
  const remaining = ordered.filter((item) => item.number > (checkpoint ?? 0));
  const selected = remaining.slice(0, limit);
  return {
    selected,
    next: remaining.length > selected.length ? (selected.at(-1)?.number ?? checkpoint) : null,
  };
}

function reader(github, checksGithub, context, budget) {
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

async function snapshotOf(github, checksGithub, io, number) {
  const { data: pr } = await io.call(github.rest.pulls.get, { pull_number: number });
  const base = { issue_number: number };
  const observations = await Promise.allSettled([
    io.pages(github.rest.issues.listComments, base),
    io.pages(github.rest.pulls.listReviewComments, { pull_number: number }),
    io.pages(github.rest.issues.listEventsForTimeline, base),
    io.pages(
      checksGithub.rest.checks.listForRef,
      { ref: pr.head.sha, filter: "latest" },
      "check_runs",
      "checks",
    ),
    io.pages(
      github.rest.actions.listWorkflowRunsForRepo,
      { head_sha: pr.head.sha },
      "workflow_runs",
    ),
    io.pages(github.rest.repos.listCommitStatusesForRef, { ref: pr.head.sha }),
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
  do {
    const response = await io.graphql(
      `query($owner:String!,$repo:String!,$number:Int!,$head:GitObjectID!,$after:String){rateLimit{remaining resetAt cost} repository(owner:$owner,name:$repo){object(oid:$head){...on Commit{oid statusCheckRollup{state}}} pullRequest(number:$number){id lastEditedAt reviews(first:100,after:$after){nodes{id databaseId:fullDatabaseId submittedAt lastEditedAt commit{oid} author{__typename ...on User{id:databaseId} ...on Bot{id:databaseId}}} pageInfo{hasNextPage endCursor}}}}}`,
      { number, head: pr.head.sha, after },
    );
    checkRollup =
      response.repository.object?.oid === pr.head.sha
        ? response.repository.object.statusCheckRollup?.state
        : null;
    meta = response.repository.pullRequest;
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
  const editHistory = await contentEdits(io, [
    ...(meta.lastEditedAt ? [{ nodeId: meta.id }] : []),
    ...[...comments, ...reviewComments]
      .filter((comment) => automated(comment.user) || comment.updated_at !== comment.created_at)
      .map((comment) => ({ nodeId: comment.node_id, commentId: comment.id })),
    ...reviews
      .filter((review) => review.lastEditedAt)
      .map((review) => ({ nodeId: review.node_id })),
  ]);
  let ownershipProtection = null;
  for (const user of [pr.user, ...pr.assignees]) {
    try {
      const { data } = await io.call(github.rest.repos.getCollaboratorPermissionLevel, {
        username: user.login,
      });
      if (ROLES.has(data.permission) || ROLES.has(data.role_name)) {
        ownershipProtection = "maintainer-ownership";
      }
    } catch (error) {
      // Missing/unknown permission evidence must not authorize a closure.
      if (error.status === 403 || error.status === 404) {
        ownershipProtection = "unknown-ownership";
      } else {
        throw error;
      }
    }
  }
  const { data: observed } = await io.call(github.rest.pulls.get, { pull_number: number });
  const unstable =
    observed.updated_at !== pr.updated_at ||
    observed.head.sha !== pr.head.sha ||
    observed.state !== pr.state;
  return {
    pr,
    comments,
    reviewComments,
    reviews,
    timeline,
    runs,
    workflowRuns,
    statuses,
    checkRollup,
    ownershipProtection,
    historyProtection,
    unstable,
    ...editHistory,
  };
}

function sameDecision(left, right) {
  return left.action === right.action && left.head === right.head && left.warning === right.warning;
}

async function mutate(github, checksGithub, mutationGithub, expectedAppId, io, decision, now) {
  const before = io.usage();
  const fresh = await snapshotOf(github, checksGithub, io, decision.number);
  const checked = evaluatePullRequest(fresh, now());
  if (!sameDecision(decision, checked)) {
    return { ...checked, action: "preserve", reason: "changed-before-mutation" };
  }
  const after = io.usage();
  // Reserve a complete second observation plus effects/readbacks before writing.
  // Larger concurrent pagination still fails visibly as an unfinished mutation.
  io.reserve({
    app: after.app - before.app + 12,
    checks: after.checks - before.checks + 2,
    graphql: after.graphql - before.graphql + 2,
  });
  const progress = {
    number: decision.number,
    head: decision.head,
    attempted: Boolean(checked.closeComment),
    commentId: checked.closeComment,
    closed: false,
  };
  const write = async (method, params) => {
    progress.attempted = true;
    return io.call(method, params);
  };
  // Failover may reuse another authenticated Barnacle receipt; new comments
  // must come from this run's selected app before any further mutation.
  const validComment = (comment, body, existing = false) =>
    comment.body === body &&
    trustedBarnacle(comment) &&
    (existing || comment.performed_via_github_app.id === expectedAppId);
  const base = { issue_number: decision.number };
  try {
    if (decision.action === "unmark") {
      await write(mutationGithub.rest.issues.removeLabel, { ...base, name: "stale" });
    } else if (decision.action === "warn") {
      const body = `${fresh.pr.assignees.length ? ASSIGNED_WARN : WARN}\n\n<!-- barnacle-stale-pr:v1 head=${decision.head} -->`;
      const { data: comment } = await write(mutationGithub.rest.issues.createComment, {
        ...base,
        body,
      });
      progress.commentId = comment.id;
      const { data: stored } = await io.call(github.rest.issues.getComment, {
        comment_id: comment.id,
      });
      if (!validComment(stored, body)) {
        throw new Error("Warning readback mismatch");
      }
      const afterWarning = await snapshotOf(github, checksGithub, io, decision.number);
      const afterDecision = evaluatePullRequest(afterWarning, now());
      if (
        afterDecision.head !== decision.head ||
        afterDecision.reason !== "warning-grace" ||
        afterDecision.warning !== stored.id
      ) {
        throw new Error(`changed-after-warning: ${afterDecision.reason}`);
      }
      try {
        await write(mutationGithub.rest.issues.addLabels, { ...base, labels: ["stale"] });
      } catch (error) {
        if (error.status !== 422 || !error.message.includes("cannot have more than 100 labels")) {
          throw error;
        }
        // The authenticated warning is the receipt; leave the user's labels intact.
        return { ...decision, reason: "label-capacity", commentId: progress.commentId };
      }
    } else if (decision.action === "close") {
      let commentId = checked.closeComment;
      if (!commentId) {
        const { data: comment } = await write(mutationGithub.rest.issues.createComment, {
          ...base,
          body: closeMessage,
        });
        commentId = comment.id;
      }
      progress.commentId = commentId;
      const { data: stored } = await io.call(github.rest.issues.getComment, {
        comment_id: commentId,
      });
      if (!validComment(stored, closeMessage, Boolean(checked.closeComment))) {
        throw new Error("Close comment readback mismatch");
      }
      const final = evaluatePullRequest(
        await snapshotOf(github, checksGithub, io, decision.number),
        now(),
        commentId,
      );
      if (!sameDecision(checked, final)) {
        throw new Error(`changed-before-close: ${final.reason}`);
      }
      io.reserve({ app: 3 });
      const { data: closed } = await write(mutationGithub.rest.pulls.update, {
        pull_number: decision.number,
        state: "closed",
      });
      progress.closed = closed.state === "closed";
      if (!progress.closed) {
        throw new Error("Closure response did not confirm closed state");
      }
      const { data: terminal } = await io.call(github.rest.pulls.get, {
        pull_number: decision.number,
      });
      const { data: issue } = await io.call(github.rest.issues.get, base);
      const actor = [...BARNACLE].find(([, app]) => app === expectedAppId)?.[0];
      if (
        terminal.state !== "closed" ||
        terminal.merged ||
        terminal.head.sha !== decision.head ||
        issue.closed_by?.id !== actor
      ) {
        throw new Error("Closure readback or actor mismatch");
      }
    }
    return { ...decision, commentId: progress.commentId };
  } catch (cause) {
    if (!progress.attempted) {
      throw cause;
    }
    throw Object.assign(
      new Error(`Unfinished PR mutation ${JSON.stringify(progress)}: ${cause.message}`),
      { code: "STALE_PR_MUTATION", progress },
    );
  }
}

/** Daily and targeted backfill share selection, decisions and mutation revalidation. */
export async function runStalePullRequests({
  github,
  checksGithub,
  mutationGithub,
  expectedAppId,
  context,
  core = console,
  dryRun = true,
  targets = [],
  maxClosures = 50,
  detailLimit = 350,
  cursorPath,
  now = Date.now,
}) {
  if (
    !github ||
    !checksGithub ||
    (!dryRun && (!mutationGithub || ![...BARNACLE.values()].includes(expectedAppId)))
  ) {
    throw new Error(
      "Explicit app reader, checks reader and live Barnacle writer identity are required",
    );
  }
  const io = reader(github, checksGithub, context, 4500);
  if (
    !Number.isSafeInteger(maxClosures) ||
    maxClosures < 0 ||
    maxClosures > 50 ||
    !Number.isSafeInteger(detailLimit) ||
    detailLimit < 1 ||
    detailLimit > 350
  ) {
    throw new Error("Invalid stale PR run bounds");
  }
  if (targets.length > 1000 || targets.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("Invalid PR targets (maximum 1000 positive PR numbers)");
  }
  await io.init();
  core.info(`Initial API quotas ${JSON.stringify(io.quotas())}`);
  const exact = targets.length > 0;
  let checkpoint = null;
  if (!exact && !dryRun && cursorPath) {
    try {
      checkpoint = JSON.parse(await readFile(cursorPath, "utf8")).lastNumber;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    if (!Number.isSafeInteger(checkpoint) || checkpoint < 0) {
      checkpoint = null;
    }
  }
  const metadataStart = io.count();
  const items = exact
    ? targets.map((number) => ({ number }))
    : await io.pages(github.rest.pulls.list, { state: "open", sort: "created", direction: "asc" });
  const metadataRequests = io.count() - metadataStart;
  // Complete metadata is collected before any close can move the open-list pages.
  // 350 details per six-hour run needs ten slices for 3292 PRs before exclusions.
  // Actual quotas can shorten slices; exact targets allow 1000 but share the
  // 4500-request ceiling and 50-close cap without reading/writing this cursor.
  const candidates = exact
    ? items
    : items.filter(
        (pr) =>
          !cheapProtection(pr) &&
          now() >= time(pr.created_at) + (pr.assignees.length ? 27 : 14) * DAY,
      );
  const slice = selectScanSlice(candidates, checkpoint, exact ? targets.length : detailLimit);
  const decisions = [];
  let closed = 0;
  let lastNumber = checkpoint;
  let exhausted = false;
  let failedTarget;
  /** @type {Error[]} */
  const failures = [];
  try {
    for (const item of slice.selected) {
      failedTarget = item.number;
      try {
        let decision = evaluatePullRequest(
          await snapshotOf(github, checksGithub, io, item.number),
          now(),
        );
        if (
          !dryRun &&
          decision.action !== "preserve" &&
          (decision.action !== "close" || closed < maxClosures)
        ) {
          decision = await mutate(
            github,
            checksGithub,
            mutationGithub,
            expectedAppId,
            io,
            decision,
            now,
          );
          if (decision.action === "close") {
            closed++;
          }
        } else if (!dryRun && decision.action === "close") {
          // Do not advance over eligible closures that the per-run cap left untouched.
          break;
        }
        decisions.push(decision);
        lastNumber = item.number;
        core.info(JSON.stringify(decision));
      } catch (error) {
        if (error.code === "STALE_PR_BUDGET") {
          core.warning?.(error.message);
          exhausted = true;
          break;
        }
        if (error.code === "STALE_PR_MUTATION") {
          closed += Number(error.progress.closed);
          decisions.push({
            ...error.progress,
            action: "preserve",
            reason: "mutation-verification-incomplete",
          });
        }
        throw error;
      }
    }
    failedTarget = undefined;
  } catch (error) {
    failures.push(error);
  }
  // All exits retain prior effects. Observation failures must not skip the
  // checkpoint/summary, and persistence failures must not hide confirmed closes.
  const next =
    failures.length === 0 && !exhausted && decisions.length === slice.selected.length
      ? slice.next
      : lastNumber;
  let checkpointWritten = false;
  if (!exact && !dryRun && cursorPath && (failures.length === 0 || lastNumber !== checkpoint)) {
    try {
      await mkdir(dirname(cursorPath), { recursive: true });
      await writeFile(cursorPath, JSON.stringify({ lastNumber: next }) + "\n");
      checkpointWritten = true;
      core.setOutput?.("checkpoint-written", "true");
    } catch (error) {
      failures.push(error);
    }
  }
  const summary = {
    dryRun,
    exact,
    totalOpen: items.length,
    metadataRequests,
    requests: io.count(),
    resourceUsage: io.usage(),
    quotas: io.quotas(),
    considered: decisions.length,
    closed,
    remainingClosures: Math.max(0, maxClosures - closed),
    checkpoint,
    next,
    checkpointWritten,
    exhausted,
    unfinished: failures.length > 0,
    failedTarget,
    failures: failures.map((error) => error.message),
  };
  core.info(`Stale PR scan ${JSON.stringify(summary)}`);
  try {
    if (core.summary) {
      await core.summary
        .addHeading("Barnacle stale PR lifecycle")
        .addCodeBlock(JSON.stringify({ ...summary, decisions }, null, 2), "json")
        .write();
    }
  } catch (error) {
    failures.push(error);
  }
  for (const error of failures) {
    core.error?.(error.message);
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, failures.map((error) => error.message).join("; "), {
      cause: failures[0],
    });
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  return { ...summary, decisions };
}

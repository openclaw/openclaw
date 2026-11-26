// Barnacle owns PR inactivity. GitHub updated_at also changes when review bots work.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { hasVerifiedResponseClosure } from "./barnacle-auto-response.mjs";
import {
  BARNACLE,
  time,
  trustedBarnacle,
  labelsOf,
  cheapProtection,
  securityProtection,
  reader,
  snapshotOf,
  humanActivityAt,
} from "./barnacle-state.mjs";

const DAY = 86_400_000;
const CI_GATES = new Set(["openclaw/ci-gate", "CI gate", "ci-gate"]);
const PRODUCT_CHECKS = new Set(["checks-node-core", "check", "build-smoke", "build-artifacts"]);
const WARN =
  "This pull request has been automatically marked as stale due to inactivity.\nPlease add updates or it will be closed.";
const ASSIGNED_WARN =
  "This assigned pull request has been automatically marked as stale after being open for 27 days.\nPlease add updates or it will be closed.";
export const closeMessage =
  "Closing due to inactivity.\nIf you believe this PR should be revived, post in #clawtributors on Discord to talk to a maintainer.\nThat channel is the escape hatch for high-quality PRs that get auto-closed.\n";
export function policyFor(item) {
  const bug = !item.head && labelsOf(item).includes("bug");
  return {
    lane: bug ? "bug" : item.assignees?.length ? "assigned" : "unassigned",
    inactiveDays: bug ? 30 : item.assignees?.length ? 14 : 7,
    graceDays: bug ? 14 : 7,
  };
}

export function noticeBody(item) {
  const policy = policyFor(item);
  const kind = item.head ? "pull-request" : "issue";
  return [
    policy.lane === "bug"
      ? "This bug report has had no qualifying human activity for 30 days. Please retest on the current release and share the result."
      : `This ${item.head ? "pull request" : "issue"} has been automatically marked as stale after ${policy.inactiveDays} days without qualifying human activity.`,
    `Without new human activity, Barnacle may close it as not planned ${policy.graceDays} days after this message was posted. This is administrative inactivity cleanup, not a claim that the problem is fixed.`,
    "A human update restarts the inactivity clock; a new PR head also restarts it. A maintainer can add no-stale for a durable hold, or bad-barnacle to suppress Barnacle. Remove the hold when work can resume.",
    `<!-- barnacle-stale:v2 item=${item.number} kind=${kind} lane=${policy.lane} head=${item.head?.sha ?? "none"} -->`,
    "",
  ].join("\n");
}

export function closeBody(item, warning, activity) {
  return item.head
    ? closeMessage
    : `Closing as not planned after the inactivity notice and full retest/update grace. This is an administrative close; the reported problem has not been confirmed fixed. Please reopen with current reproduction details if it still occurs.\n\n<!-- barnacle-close:v2 item=${item.number} warning=${warning} activity=${new Date(activity).toISOString()} -->\n`;
}

const isWarning = (comment) =>
  [WARN, ASSIGNED_WARN].includes(
    comment.body.split("\n\n<!-- barnacle-stale-pr:v1")[0].trimEnd(),
  ) || comment.body.includes("<!-- barnacle-stale:v2 ");
const warningHead = (comment) =>
  /<!-- barnacle-stale(?:-pr:v1|:v2 item=\d+ kind=pull-request lane=[a-z]+) head=([0-9a-f]{40}) -->/.exec(
    comment.body,
  )?.[1];

function latestWarning(snapshot) {
  return snapshot.comments
    .filter((comment) => trustedBarnacle(comment) && comment.body === noticeBody(snapshot.pr))
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
  let latest = humanActivityAt(snapshot, ignoredComment);
  const earliest = snapshot.pr.head && headWitnesses(snapshot).toSorted((a, b) => a.at - b.at)[0];
  if (earliest && earliest.source !== "warning-head") {
    latest = Math.max(latest, earliest.at);
  }
  return latest;
}

/** Evaluate only authoritative GitHub facts; never use the PR's raw updated_at. */
export function evaluateItem(snapshot, now = Date.now(), ignoredComment = null) {
  const { pr, comments, runs } = snapshot;
  const head = pr.head?.sha ?? null;
  const kind = head ? "pull-request" : "issue";
  const result = (action, reason, extra = {}) => ({
    number: pr.number,
    kind,
    head,
    lane: policyFor(pr).lane,
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
    (runs ?? []).some(
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
  const witnesses = head ? headWitnesses(snapshot) : [];
  const activity = activityAt(snapshot, ignoredComment);
  const ownClose =
    warning &&
    comments.findLast(
      (comment) =>
        trustedBarnacle(comment) &&
        comment.body === closeBody(pr, warning.id, activity) &&
        time(comment.created_at) >= time(warning.created_at) &&
        !warningWasEdited(snapshot, comment),
    );
  const policy = policyFor(pr);
  const eligibleAt = activity + policy.inactiveDays * DAY;
  if (now < eligibleAt) {
    return result(
      labelsOf(pr).includes("stale") ? "unmark" : "preserve",
      "human-or-head-activity",
      { eligibleAt: new Date(eligibleAt).toISOString() },
    );
  }
  if (!warning || warningWasEdited(snapshot, warning)) {
    if (head && !witnesses.length) {
      return result("preserve", "unknown-head-timing");
    }
    return result("warn", warning ? "edited-warning" : "initial-warning");
  }
  const warningAt = time(warning.created_at);
  if (activity >= warningAt) {
    return result("warn", "activity-after-warning");
  }
  const closeAt = warningAt + policy.graceDays * DAY;
  if (now < closeAt) {
    return result("preserve", "warning-grace", {
      warning: warning.id,
      witness: head ? "warning-head" : "issue-notice",
      eligibleAt: new Date(closeAt).toISOString(),
    });
  }
  return result("close", "expired-warning", {
    warning: warning.id,
    witness: head ? "warning-head" : "issue-notice",
    closeComment: ownClose?.id,
    activityAt: activity,
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

/** Audit historical effects, not today's labels: new holds cannot rewrite a receipt. */
export async function auditRecentBugClosures({ github, context, now = Date.now, core = console }) {
  const io = reader(github, github, context, 4500);
  const cutoff = now() - 2 * DAY;
  const items = await io.pages(github.rest.issues.listForRepo, {
    state: "closed",
    labels: "bug",
    since: new Date(cutoff).toISOString(),
    sort: "updated",
    direction: "desc",
  });
  const violations = [];
  for (const item of items.filter(
    (candidate) => !candidate.pull_request && time(candidate.closed_at) >= cutoff,
  )) {
    const snapshot = await snapshotOf(github, github, io, item.number, "issue");
    const event = snapshot.timeline.findLast((entry) => entry.event === "closed");
    if (!BARNACLE.has(event?.actor?.id)) {
      continue;
    }
    const at = time(event.created_at);
    const past = {
      ...snapshot,
      comments: snapshot.comments.filter((comment) => time(comment.created_at) <= at),
      timeline: snapshot.timeline.filter((entry) => time(entry.created_at) < at),
      edits: snapshot.edits.filter((edit) => time(edit.editedAt) <= at),
    };
    // Reason-driven responses have their own exact authenticated receipt. They
    // are not inactivity closures and must not acquire a retest/grace claim.
    if (hasVerifiedResponseClosure(snapshot, event)) {
      continue;
    }
    const warning = latestWarning(past);
    const activity = humanActivityAt(past);
    const receipt =
      warning &&
      past.comments.findLast(
        (comment) =>
          trustedBarnacle(comment) &&
          comment.body === closeBody(item, warning.id, activity) &&
          time(comment.created_at) >= time(warning.created_at) &&
          !warningWasEdited(snapshot, comment),
      );
    if (
      snapshot.pr.state_reason !== "not_planned" ||
      snapshot.pr.closed_by?.id !== event.actor.id ||
      snapshot.activityProtection ||
      !warning ||
      warningWasEdited(snapshot, warning) ||
      !receipt ||
      time(warning.created_at) < activity + 30 * DAY ||
      at < time(warning.created_at) + 14 * DAY ||
      policyFor(item).lane !== "bug"
    ) {
      violations.push(item.number);
    }
  }
  if (violations.length) {
    throw new Error(`Unauthenticated or premature Barnacle bug closures: ${violations.join(", ")}`);
  }
  core.info(`Audited ${items.length} recent closed bug reports; current-policy receipts verified`);
  return { inspected: items.length, violations };
}

function sameDecision(left, right) {
  return (
    left.action === right.action &&
    left.head === right.head &&
    left.warning === right.warning &&
    left.lane === right.lane &&
    left.closeComment === right.closeComment
  );
}

async function mutate(github, checksGithub, mutationGithub, expectedAppId, io, decision, now) {
  const before = io.usage();
  const fresh = await snapshotOf(github, checksGithub, io, decision.number, decision.kind);
  const checked = evaluateItem(fresh, now());
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
    comment.created_at === comment.updated_at &&
    trustedBarnacle(comment) &&
    (existing || comment.performed_via_github_app.id === expectedAppId);
  const base = { issue_number: decision.number };
  try {
    if (decision.action === "unmark") {
      await write(mutationGithub.rest.issues.removeLabel, { ...base, name: "stale" });
    } else if (decision.action === "warn") {
      const body = noticeBody(fresh.pr);
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
      const afterWarning = await snapshotOf(
        github,
        checksGithub,
        io,
        decision.number,
        decision.kind,
      );
      const afterDecision = evaluateItem(afterWarning, now());
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
          body: closeBody(fresh.pr, checked.warning, checked.activityAt),
        });
        commentId = comment.id;
      }
      progress.commentId = commentId;
      const { data: stored } = await io.call(github.rest.issues.getComment, {
        comment_id: commentId,
      });
      if (
        !validComment(
          stored,
          closeBody(fresh.pr, checked.warning, checked.activityAt),
          Boolean(checked.closeComment),
        )
      ) {
        throw new Error("Close comment readback mismatch");
      }
      const final = evaluateItem(
        await snapshotOf(github, checksGithub, io, decision.number, decision.kind),
        now(),
        commentId,
      );
      // Posting advances the decision's receipt identity. Losing or editing
      // that exact receipt cannot authorize the close through another notice.
      if (!sameDecision({ ...checked, closeComment: commentId }, final)) {
        throw new Error(`changed-before-close: ${final.reason}`);
      }
      io.reserve({ app: 3 });
      const { data: closed } = decision.head
        ? await write(mutationGithub.rest.pulls.update, {
            pull_number: decision.number,
            state: "closed",
          })
        : await write(mutationGithub.rest.issues.update, {
            issue_number: decision.number,
            state: "closed",
            state_reason: "not_planned",
          });
      progress.closed = closed.state === "closed";
      if (!progress.closed) {
        throw new Error("Closure response did not confirm closed state");
      }
      const { data: terminal } = await io.call(
        decision.head ? github.rest.pulls.get : github.rest.issues.get,
        decision.head ? { pull_number: decision.number } : base,
      );
      const { data: issue } = await io.call(github.rest.issues.get, base);
      const actor = [...BARNACLE].find(([, app]) => app === expectedAppId)?.[0];
      if (
        terminal.state !== "closed" ||
        terminal.merged ||
        (terminal.head?.sha ?? null) !== decision.head ||
        (!decision.head && issue.state_reason !== "not_planned") ||
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
export async function runStaleLifecycle({
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
  includeIssues = false,
  includePrs = true,
  targetKind = "pull-request",
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
    ? []
    : [
        ...(includePrs
          ? (
              await io.pages(github.rest.pulls.list, {
                state: "open",
                sort: "created",
                direction: "asc",
              })
            ).map((pr) => Object.assign({}, pr, { kind: "pull-request" }))
          : []),
        ...(includeIssues
          ? (
              await io.pages(github.rest.issues.listForRepo, {
                state: "open",
                sort: "created",
                direction: "asc",
              })
            )
              .filter((item) => !item.pull_request)
              .map((issue) => Object.assign({}, issue, { kind: "issue" }))
          : []),
      ];
  for (const number of exact ? [...new Set(targets)] : []) {
    const kind =
      targetKind === "auto"
        ? (await io.call(github.rest.issues.get, { issue_number: number })).data.pull_request
          ? "pull-request"
          : "issue"
        : targetKind;
    if ((kind === "issue" && includeIssues) || (kind === "pull-request" && includePrs)) {
      items.push({ number, kind });
    }
  }
  const metadataRequests = io.count() - metadataStart;
  // Complete metadata is collected before any close can move the open-list pages.
  // 350 details per six-hour run needs ten slices for 3292 PRs before exclusions.
  // Actual quotas can shorten slices; exact targets allow 1000 but share the
  // 4500-request ceiling and 50-close cap without reading/writing this cursor.
  const candidates = exact
    ? items
    : items.filter(
        (pr) =>
          !cheapProtection(pr) && now() >= time(pr.created_at) + policyFor(pr).inactiveDays * DAY,
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
        let decision = evaluateItem(
          await snapshotOf(github, checksGithub, io, item.number, item.kind),
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
  core.info(`Stale issue/PR scan ${JSON.stringify(summary)}`);
  try {
    if (core.summary) {
      await core.summary
        .addHeading("Barnacle issue/PR lifecycle")
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

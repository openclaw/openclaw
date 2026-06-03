const defaultReadyLabels = ["clawsweeper:automerge", "clawsweeper:merge-ready"];
const defaultFixLabels = ["clawsweeper:queueable-fix"];
const stewardMarker = "<!-- openclaw:pr-queue-steward -->";
const codexFixMarkerPrefix = "<!-- openclaw:codex-ci-fix-dispatch:";

const statusBlocksMerge = new Set(["ERROR", "FAILURE"]);
const statusAllowsQueue = new Set(["SUCCESS"]);
const mergeStateBlocks = new Set([
  "BLOCKED",
  "BEHIND",
  "DIRTY",
  "DRAFT",
  "HAS_HOOKS",
  "UNKNOWN",
  "UNSTABLE",
]);

const parseList = (value, fallback = []) => {
  if (!value || typeof value !== "string") return fallback;
  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
};

const parseBoolean = (value, fallback = false) => {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
};

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const code = (value) => `\`${String(value ?? "").replaceAll("`", "\\`")}\``;

const checkbox = (value) => (value ? "yes" : "no");

const labelSetFor = (pullRequest) =>
  new Set((pullRequest.labels?.nodes ?? []).map((label) => label.name).filter(Boolean));

const hasAnyLabel = (labels, wanted) => wanted.some((label) => labels.has(label));

const rollupStateFor = (pullRequest) => pullRequest.statusCheckRollup?.state ?? "NONE";

const markdownEscape = (value) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ")
    .slice(0, 180);

const formatPr = (pullRequest) => `[#${pullRequest.number}](${pullRequest.url})`;

const resultPriority = {
  enqueued: 1,
  "codex-fix-dispatched": 2,
  "already-queued": 3,
  "queue-unavailable": 4,
  blocked: 5,
  waiting: 6,
  skipped: 7,
};

const sortResults = (left, right) =>
  (resultPriority[left.result] ?? 99) - (resultPriority[right.result] ?? 99) ||
  left.pullRequest.number - right.pullRequest.number;

const prQuery = `
query PullRequestsForSteward(
  $owner: String!
  $repo: String!
  $baseRefName: String!
  $first: Int!
) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef {
      name
    }
    pullRequests(
      first: $first
      states: OPEN
      baseRefName: $baseRefName
      orderBy: { field: CREATED_AT, direction: ASC }
    ) {
      nodes {
        id
        number
        title
        url
        isDraft
        mergeable
        mergeStateStatus
        reviewDecision
        headRefName
        headRefOid
        baseRefName
        isInMergeQueue
        isMergeQueueEnabled
        labels(first: 50) {
          nodes {
            name
          }
        }
        autoMergeRequest {
          enabledAt
          enabledBy {
            login
          }
        }
        statusCheckRollup {
          state
        }
      }
    }
  }
}`;

const enqueueMutation = `
mutation EnqueuePullRequest($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enqueuePullRequest(input: {
    pullRequestId: $pullRequestId
    expectedHeadOid: $expectedHeadOid
  }) {
    mergeQueueEntry {
      id
      position
    }
  }
}`;

async function listIssueComments(github, context, issueNumber) {
  return github.paginate(github.rest.issues.listComments, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: issueNumber,
    per_page: 100,
  });
}

async function upsertComment({ github, context, pullRequest, body }) {
  const comments = await listIssueComments(github, context, pullRequest.number);
  const existing = comments.find(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      typeof comment.body === "string" &&
      comment.body.includes(stewardMarker),
  );

  if (existing) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: existing.id,
      body,
    });
    return;
  }

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pullRequest.number,
    body,
  });
}

async function hasCodexFixDispatchMarker({ github, context, pullRequest }) {
  const marker = `${codexFixMarkerPrefix}${pullRequest.headRefOid} -->`;
  const comments = await listIssueComments(github, context, pullRequest.number);
  return comments.some(
    (comment) =>
      comment.user?.login === "github-actions[bot]" &&
      typeof comment.body === "string" &&
      comment.body.includes(marker),
  );
}

async function recordCodexFixDispatch({ github, context, pullRequest, workflowFile }) {
  const marker = `${codexFixMarkerPrefix}${pullRequest.headRefOid} -->`;
  const body = [
    marker,
    "Codex CI fix dispatched for this PR head.",
    "",
    `- PR: ${formatPr(pullRequest)}`,
    `- Head: ${code(pullRequest.headRefOid)}`,
    `- Workflow: ${code(workflowFile)}`,
    `- Steward run: ${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  ].join("\n");

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: pullRequest.number,
    body,
  });
}

const blockersFor = ({ pullRequest, labels, readyLabels, requireApproval }) => {
  const blockers = [];
  const rollupState = rollupStateFor(pullRequest);

  if (pullRequest.isDraft) blockers.push("draft");
  if (!hasAnyLabel(labels, readyLabels))
    blockers.push(`missing ready label (${readyLabels.join(", ")})`);
  if (pullRequest.mergeable === "CONFLICTING") blockers.push("merge conflict");
  if (mergeStateBlocks.has(pullRequest.mergeStateStatus)) {
    blockers.push(`merge state ${pullRequest.mergeStateStatus}`);
  }
  if (pullRequest.reviewDecision === "CHANGES_REQUESTED") blockers.push("changes requested");
  if (requireApproval && pullRequest.reviewDecision !== "APPROVED")
    blockers.push("review not approved");
  if (!statusAllowsQueue.has(rollupState)) blockers.push(`checks ${rollupState.toLowerCase()}`);

  return blockers;
};

function resultRow(entry) {
  const pr = entry.pullRequest;
  return [
    formatPr(pr),
    markdownEscape(pr.title),
    code(entry.result),
    markdownEscape(entry.detail),
    code(rollupStateFor(pr)),
    code(pr.mergeStateStatus),
    code(pr.reviewDecision ?? "none"),
  ];
}

async function writeSummary({ core, baseBranch, readyLabels, fixLabels, results, options }) {
  const rows = results.toSorted(sortResults).map(resultRow);
  const table = [
    "| PR | Title | Result | Detail | Checks | Merge state | Review |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

  await core.summary
    .addHeading("PR Queue Steward")
    .addRaw(`Base branch: ${code(baseBranch)}\n\n`)
    .addRaw(`Ready labels: ${readyLabels.map(code).join(", ")}\n\n`)
    .addRaw(`Fix labels: ${fixLabels.map(code).join(", ")}\n\n`)
    .addRaw(`Enqueue ready PRs: ${checkbox(options.enqueueReady)}\n\n`)
    .addRaw(`Dispatch Codex CI fixes: ${checkbox(options.dispatchCodexFixes)}\n\n`)
    .addRaw(rows.length > 0 ? table : "No open pull requests matched the steward query.")
    .write();
}

function actionCommentFor(entry) {
  const pr = entry.pullRequest;
  return [
    stewardMarker,
    "### PR queue steward",
    "",
    `Result: ${code(entry.result)}`,
    `Detail: ${entry.detail}`,
    "",
    `Head: ${code(pr.headRefOid)}`,
    `Checks: ${code(rollupStateFor(pr))}`,
    `Merge state: ${code(pr.mergeStateStatus)}`,
    `Review: ${code(pr.reviewDecision ?? "none")}`,
  ].join("\n");
}

async function dispatchCodexFix({ github, context, pullRequest, baseBranch, workflowFile }) {
  await github.rest.actions.createWorkflowDispatch({
    owner: context.repo.owner,
    repo: context.repo.repo,
    workflow_id: workflowFile,
    ref: baseBranch,
    inputs: {
      pr_number: String(pullRequest.number),
      head_sha: pullRequest.headRefOid,
      base_branch: baseBranch,
    },
  });
}

async function handlePullRequest({ github, context, pullRequest, config }) {
  const labels = labelSetFor(pullRequest);
  const rollupState = rollupStateFor(pullRequest);
  const blockers = blockersFor({
    pullRequest,
    labels,
    readyLabels: config.readyLabels,
    requireApproval: config.requireApproval,
  });

  if (pullRequest.isInMergeQueue) {
    return { pullRequest, result: "already-queued", detail: "already in the merge queue" };
  }

  const canDispatchFix =
    config.dispatchCodexFixes &&
    config.canDispatchCodexFixes &&
    hasAnyLabel(labels, config.fixLabels) &&
    statusBlocksMerge.has(rollupState) &&
    !pullRequest.isDraft &&
    pullRequest.mergeable !== "CONFLICTING";

  if (canDispatchFix) {
    if (await hasCodexFixDispatchMarker({ github, context, pullRequest })) {
      return {
        pullRequest,
        result: "waiting",
        detail: "Codex CI fix was already dispatched for this head SHA",
      };
    }

    await dispatchCodexFix({
      github,
      context,
      pullRequest,
      baseBranch: config.baseBranch,
      workflowFile: config.codexFixWorkflow,
    });
    await recordCodexFixDispatch({
      github,
      context,
      pullRequest,
      workflowFile: config.codexFixWorkflow,
    });
    return {
      pullRequest,
      result: "codex-fix-dispatched",
      detail: "failed checks and queueable-fix label triggered Codex CI fix workflow",
    };
  }

  if (blockers.length > 0) {
    return { pullRequest, result: "blocked", detail: blockers.join("; ") };
  }

  if (!config.enqueueReady) {
    return {
      pullRequest,
      result: "waiting",
      detail: "ready, but enqueue is disabled for this run",
    };
  }

  if (!pullRequest.isMergeQueueEnabled) {
    return {
      pullRequest,
      result: "queue-unavailable",
      detail: "merge queue is not enabled for this target branch",
    };
  }

  try {
    const response = await github.graphql(enqueueMutation, {
      pullRequestId: pullRequest.id,
      expectedHeadOid: pullRequest.headRefOid,
    });
    const position = response.enqueuePullRequest?.mergeQueueEntry?.position;
    return {
      pullRequest,
      result: "enqueued",
      detail:
        position == null ? "added to merge queue" : `added to merge queue at position ${position}`,
    };
  } catch (error) {
    return {
      pullRequest,
      result: "blocked",
      detail: `enqueue failed: ${error.message}`,
    };
  }
}

export async function runPrQueueSteward({ github, context, core }) {
  const baseBranch = process.env.PR_STEWARD_BASE_BRANCH || "main";
  const maxPullRequests = parseInteger(process.env.PR_STEWARD_MAX_PRS, 30);
  const readyLabels = parseList(process.env.PR_STEWARD_READY_LABELS, defaultReadyLabels);
  const fixLabels = parseList(process.env.PR_STEWARD_FIX_LABELS, defaultFixLabels);
  const commentMode = process.env.PR_STEWARD_COMMENT_MODE || "actions";
  const config = {
    baseBranch,
    readyLabels,
    fixLabels,
    enqueueReady: parseBoolean(process.env.PR_STEWARD_ENQUEUE_READY, true),
    dispatchCodexFixes: parseBoolean(process.env.PR_STEWARD_DISPATCH_CODEX_FIXES, true),
    canDispatchCodexFixes: parseBoolean(process.env.PR_STEWARD_CAN_DISPATCH_CODEX_FIXES, false),
    requireApproval: parseBoolean(process.env.PR_STEWARD_REQUIRE_APPROVAL, false),
    codexFixWorkflow: process.env.PR_STEWARD_CODEX_FIX_WORKFLOW || "codex-fix-ci.yml",
  };

  const response = await github.graphql(prQuery, {
    owner: context.repo.owner,
    repo: context.repo.repo,
    baseRefName: baseBranch,
    first: maxPullRequests,
  });
  const pullRequests = response.repository?.pullRequests?.nodes ?? [];
  const results = [];

  for (const pullRequest of pullRequests) {
    const result = await handlePullRequest({ github, context, pullRequest, config });
    results.push(result);

    const shouldComment =
      commentMode === "all" ||
      (commentMode === "actions" && ["enqueued", "codex-fix-dispatched"].includes(result.result));
    if (shouldComment) {
      await upsertComment({
        github,
        context,
        pullRequest,
        body: actionCommentFor(result),
      });
    }
  }

  await writeSummary({
    core,
    baseBranch,
    readyLabels,
    fixLabels,
    results,
    options: config,
  });

  const counts = results.reduce((accumulator, result) => {
    accumulator[result.result] = (accumulator[result.result] ?? 0) + 1;
    return accumulator;
  }, {});
  core.info(`PR queue steward results: ${JSON.stringify(counts)}`);
}

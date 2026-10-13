import { stripVTControlCharacters } from "node:util";
import { validateArtifactProducerRun } from "./full-release-artifacts.mjs";
import {
  composeReleaseAttemptJobs,
  releaseChildSpec,
  validateReleaseChildDispatchBinding,
  validateReleaseChildRunProvenance,
  validateReleaseExecutionPlanArtifact,
} from "./full-release-validation-policy.mjs";
import { authenticateOriginalExecutionPlanDigest } from "./release-ci-summary.mjs";

const ARTIFACT_JOBS = [
  ["Prepare release npm artifacts", "npm"],
  ["Prepare release Docker artifacts", "docker"],
  ["Acquire full release candidate", "candidate"],
  ["Prepare exact plugin npm artifacts", "plugin-npm"],
];

function identity(run) {
  if (
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !["requested", "queued", "pending", "waiting", "in_progress", "completed"].includes(run.status)
  ) {
    throw new Error("cancellation run has no exact attempt/lifecycle identity");
  }
  return JSON.stringify([
    run.id,
    run.run_attempt,
    run.event,
    run.path,
    run.head_sha,
    run.head_branch,
    run.display_title,
    run.repository?.full_name,
    run.actor?.login,
    run.triggering_actor?.login,
  ]);
}

function assertParent(run, plan, repository) {
  if (
    String(run.id) !== plan.parentRunId ||
    run.repository?.full_name !== repository ||
    run.event !== "workflow_dispatch" ||
    String(run.path).split("@", 1)[0] !== ".github/workflows/full-release-validation.yml" ||
    run.head_sha !== plan.workflowSha ||
    run.head_branch !== plan.workflowRef ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < plan.parentRunAttempt
  ) {
    throw new Error("cancellation parent differs from its sealed execution plan");
  }
}

function completedJob(jobs, name, attempt) {
  const matches = jobs.filter((job) => job.name === name && Number(job.run_attempt) === attempt);
  const observed = matches.length
    ? composeReleaseAttemptJobs([{ jobs: matches, runAttempt: attempt }], {
        plannedRunAttempt: attempt,
        effectiveRunAttempt: attempt,
      }).jobs
    : [];
  if (observed.length !== 1 || observed[0].status !== "completed") {
    throw new Error(
      `${name} attempt ${attempt}: dispatch observation unavailable; repeat cancellation after it settles`,
    );
  }
  // The evidence owner rejects real ambiguity but drops runnerless rerun copies.
  // Keep the original executed row for its authenticated log ID and upload steps.
  return matches.find((job) => job.status === "completed" && job.conclusion !== "skipped");
}

/** Cancel only producer-authenticated descendants; a fresh observation makes repetition resumable. */
export async function cancelReleaseTree(runId, client, options = {}) {
  const repository = client.repository ?? "openclaw/openclaw";
  const evidenceClient = client.getReleaseEvidenceClient();
  const retained = await evidenceClient.loadExecutionPlanEvidence(runId);
  const plan = validateReleaseExecutionPlanArtifact(retained.plan, {
    parentRunId: runId,
    repository,
    workflowSha: retained.artifact.workflow_run.head_sha,
    workflowRef: retained.artifact.workflow_run.head_branch,
  });
  const parent = await client.getRun(runId);
  assertParent(parent, plan, repository);
  const parentIdentity = identity(parent);
  const jobs = await client.getParentJobs(runId);
  const sealer = completedJob(jobs, "Seal release execution plan", plan.parentRunAttempt);
  const uploads =
    sealer.steps?.filter((step) => step.name === "Upload immutable release execution plan") ?? [];
  const created = Date.parse(retained.artifact.created_at);
  const uploadStart = Date.parse(uploads[0]?.started_at);
  const uploadEnd = Date.parse(uploads[0]?.completed_at);
  if (
    uploads.length !== 1 ||
    uploads[0].status !== "completed" ||
    uploads[0].conclusion !== "success" ||
    ![uploadStart, uploadEnd].every(Number.isFinite) ||
    uploadEnd < uploadStart
  ) {
    throw new Error("cancellation plan lacks its exact original successful upload");
  }
  const workflow = evidenceClient.getWorkflowSource(plan.workflowSha);
  const originalDigest = await authenticateOriginalExecutionPlanDigest(
    workflow,
    sealer,
    uploads[0],
    evidenceClient,
  );
  if (
    originalDigest
      ? plan.sha256 !== originalDigest
      : !Number.isFinite(created) || created < uploadStart || created > uploadEnd
  ) {
    throw new Error("cancellation plan differs from its authenticated original upload");
  }
  const targets = [];
  const failures = [];
  const excludedRunIds = [];
  const add = async (key, id, validate, owner) => {
    const run = await client.getRun(id);
    validate(run);
    if (targets.some((target) => target.runId === id)) {
      throw new Error(`cancellation tree repeats run ${id}`);
    }
    targets.push({ key, runId: id, run, validate, depth: owner ? 2 : 1, owner });
  };
  for (const child of plan.children.filter((entry) => entry.selected)) {
    if (child.source === "reused" || plan.evidenceReuse.requested || plan.childReuse?.[child.key]) {
      excludedRunIds.push(child.runId);
      continue;
    }
    try {
      if (!child.runId || !child.runAttempt) {
        throw new Error(`${child.key}: sealed child has no exact dispatch identity`);
      }
      const job = completedJob(
        jobs,
        releaseChildSpec(child.key).parentJobName,
        child.sourceParentAttempt ?? plan.parentRunAttempt,
      );
      const log = await client.getJobLog(job.id);
      validateReleaseChildDispatchBinding({
        child,
        log,
        repository,
        targetSha: plan.targetSha,
        coveragePolicy: plan.coveragePolicy,
        plannedRunAttempt: child.runAttempt,
      });
      await add(child.key, child.runId, (run) =>
        validateReleaseChildRunProvenance(run, {
          ...child,
          repository,
          plannedRunAttempt: child.runAttempt,
        }),
      );
    } catch (error) {
      failures.push(error.message);
    }
  }
  for (const [name, stage] of ARTIFACT_JOBS) {
    const matches = jobs.filter(
      (job) => job.name === name && Number(job.run_attempt) === plan.parentRunAttempt,
    );
    if (!matches.length || matches.every((job) => job.conclusion === "skipped")) {
      continue;
    }
    try {
      const job = completedJob(jobs, name, plan.parentRunAttempt);
      const log = stripVTControlCharacters(await client.getJobLog(job.id));
      const producerWorkflow =
        stage === "plugin-npm" ? "plugin-npm-release.yml" : "full-release-artifacts.yml";
      const dispatches = [
        ...log.matchAll(
          /(?:^|\n)(?:\d{4}-\d\d-\d\dT\S+ )?Dispatched ([\w.-]+\.ya?ml): https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/([1-9][0-9]*) \(attempt ([1-9][0-9]*)\)\r?(?=\n|$)/gu,
        ),
      ];
      // Reused artifacts have no dispatch in this parent's job and remain borrowed.
      if (!dispatches.length && log.includes("PUBLICATION_ARTIFACTS_REUSED: true")) {
        continue;
      }
      if (
        dispatches.length !== 1 ||
        dispatches[0][1] !== producerWorkflow ||
        dispatches[0][2] !== repository
      ) {
        throw new Error(`${name}: exact artifact dispatch unavailable`);
      }
      const producerRunId = dispatches[0][3];
      const producerAttempt = dispatches[0][4];
      const dispatchId =
        stage === "plugin-npm"
          ? `full-release-validation-${runId}-${plan.parentRunAttempt}-plugin-npm-preflight`
          : `full-release-validation-${runId}-${plan.parentRunAttempt}-artifacts-${stage}`;
      const request = {
        stage,
        repository,
        toolingSha: plan.workflowSha,
        workflowRef: plan.workflowRef,
        dispatchId,
      };
      await add(`artifact:${stage}`, producerRunId, (run) => {
        if (stage !== "plugin-npm") {
          validateArtifactProducerRun(request, run, producerRunId, producerAttempt, {
            allowFailure: true,
            allowNewerAttempts: true,
          });
          return;
        }
        const title =
          /^Plugin NPM Artifact Preflight \[[a-zA-Z0-9._-]{1,128}\] ([a-f0-9]{40}) \(([^()\r\n]+)\)$/u.exec(
            run.display_title,
          );
        if (title?.[1] !== plan.targetSha || title[2] !== dispatchId) {
          throw new Error("plugin npm producer dispatch provenance changed");
        }
        validateReleaseChildRunProvenance(run, {
          key: "plugin-npm",
          repository,
          runId: producerRunId,
          plannedRunAttempt: Number(producerAttempt),
          workflow: producerWorkflow,
          workflowSha: plan.workflowSha,
          workflowRef: plan.workflowRef,
          displayTitle: run.display_title,
        });
      });
    } catch (error) {
      failures.push(error.message);
    }
  }
  for (const owner of [...targets].filter((target) => target.key.startsWith("releaseChecks"))) {
    if (owner.run.run_attempt > 100) {
      failures.push(`${owner.key}: descendant attempt history exceeds its limit`);
      continue;
    }
    for (let attempt = 1; attempt <= owner.run.run_attempt; attempt += 1) {
      try {
        const childJobs = await client.getAttemptJobs(owner.runId, attempt);
        const matches = childJobs.filter((job) => job.name === "Run QA Lab live Telegram lane");
        if (!matches.length && owner.run.status !== "completed") {
          throw new Error(`${owner.key}: nested dispatch has not settled`);
        }
        if (!matches.length || matches.every((job) => job.conclusion === "skipped")) {
          continue;
        }
        const job = completedJob(childJobs, "Run QA Lab live Telegram lane", attempt);
        const log = stripVTControlCharacters(await client.getJobLog(job.id));
        const links = [
          ...log.matchAll(
            /(?:^|\n)(?:\d{4}-\d\d-\d\dT\S+ )?Dispatched trusted Telegram QA: https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/([1-9][0-9]*)\r?(?=\n|$)/gu,
          ),
        ];
        if (links.length !== 1 || links[0][1] !== repository) {
          throw new Error(`${owner.key}: exact Telegram descendant unavailable`);
        }
        await add(
          `${owner.key}:telegram:${attempt}`,
          links[0][2],
          (run) => {
            const title =
              /^OpenClaw Release Telegram QA release-checks-([1-9][0-9]*)-([1-9][0-9]*)-[a-f0-9]{32}$/u.exec(
                run.display_title,
              );
            if (
              String(run.id) !== links[0][2] ||
              run.repository?.full_name !== repository ||
              run.event !== "workflow_dispatch" ||
              run.actor?.login !== "github-actions[bot]" ||
              String(run.path).split("@", 1)[0] !==
                ".github/workflows/openclaw-release-telegram-qa.yml" ||
              run.head_sha !== owner.run.head_sha ||
              run.head_branch !== owner.run.head_branch ||
              title?.[1] !== owner.runId ||
              title[2] !== String(attempt)
            ) {
              throw new Error(`${owner.key}: Telegram descendant provenance changed`);
            }
          },
          owner,
        );
      } catch (error) {
        failures.push(error.message);
      }
    }
  }
  targets.push({
    key: "parent",
    runId,
    run: parent,
    validate: (run) => assertParent(run, plan, repository),
    depth: 0,
  });
  targets.sort((left, right) => right.depth - left.depth);
  const cancellation = [];
  const responseFailures = new Map();
  for (const target of targets) {
    try {
      // Finish awaited target reads before refreshing its originating lineage.
      // REST has no attempt-CAS cancellation; these fresh reads fence observed replacement.
      const current = await client.getRun(target.runId);
      target.validate(current);
      if (identity(current) !== identity(target.run)) {
        throw new Error(
          `${target.key}: attempt changed before cancellation; repeat with fresh authority`,
        );
      }
      if (
        target.owner &&
        identity(await client.getRun(target.owner.runId)) !== identity(target.owner.run)
      ) {
        throw new Error(`${target.key}: descendant owner changed before cancellation`);
      }
      const root = await client.getRun(runId);
      if (identity(root) !== parentIdentity) {
        throw new Error("cancellation parent attempt changed; repeat with fresh authority");
      }
      let state = "terminal";
      if (current.status !== "completed") {
        state = options.dryRun ? "would-cancel" : "requested";
        if (!options.dryRun) {
          // 202 is acknowledgment only; 409/transport failures are reconciled below, never retried.
          try {
            await client.cancelRun(target.runId, options.force === true);
          } catch (error) {
            responseFailures.set(
              target.runId,
              `${target.key}: cancellation response unavailable (${error.message})`,
            );
          }
        }
      }
      cancellation.push({
        key: target.key,
        runId: target.runId,
        runAttempt: current.run_attempt,
        state,
      });
    } catch (error) {
      failures.push(error.message);
    }
  }
  const activeRunIds = [];
  for (const target of targets) {
    try {
      const current = await client.getRun(target.runId);
      target.validate(current);
      if (identity(current) !== identity(target.run)) {
        throw new Error(`${target.key}: attempt changed during cancellation reconciliation`);
      }
      if (current.status !== "completed") {
        activeRunIds.push(target.runId);
      } else {
        responseFailures.delete(target.runId);
      }
    } catch (error) {
      failures.push(error.message);
    }
  }
  failures.push(...responseFailures.values());
  const nextCommand = `pnpm frv cancel --run ${runId} --repo ${repository}${options.force ? " --force" : ""}`;
  return {
    action: options.dryRun ? "would-cancel-tree" : "cancellation-requested",
    complete: activeRunIds.length === 0 && failures.length === 0,
    cancellation,
    activeRunIds,
    excludedRunIds,
    failures,
    nextCommand,
  };
}

#!/usr/bin/env node
import { execFile } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { promisify, stripVTControlCharacters } from "node:util";
import { validateArtifactProducerRun } from "./full-release-artifacts.mjs";
import {
  publicationAdmissionContract,
  publicationSourceContract,
  validatePublicationAdmissionBinding,
  validatePublicationSourceBinding,
} from "./full-release-publication-contract.mjs";
import {
  classifyReleaseGhTransportError,
  composeReleaseChildAttemptEvidence,
  formatReleaseStateOutcome,
  isReleaseGhArtifactMissingError,
  MAX_RELEASE_ARTIFACT_BYTES,
  planReleaseChildRerun,
  releaseChildSpec,
  releaseChildSpecs,
  releaseGhRateLimitRetryAt,
  terminalPolicyPass,
  validateReleaseChildDispatchBinding,
  validateReleaseChildRunProvenance,
  validateReleaseExecutionPlanArtifact,
  validateReleaseStateArtifact,
} from "./full-release-validation-policy.mjs";
import {
  inspectActionsArtifactZipWithPolicy,
  sha256Digest,
} from "./lib/actions-artifact-archive.mjs";
import { execPlainGh, plainGhAuthenticatedEnv, resolvePlainGhBin } from "./lib/plain-gh.mjs";
import {
  RELEASE_PRIORITY_VARIABLE,
  describeRun,
  isDeferrableRun,
  isDeferredCiJobSet,
  listReleasePriorityRuns,
  readReleasePriorityRecord,
  selectDeferredRunCandidates,
  selectLatestRunsPerLane,
} from "./lib/release-priority.mjs";
import { sleep } from "./lib/sleep.mjs";
import {
  createReleaseEvidenceClient,
  releaseExecutionPlanRestoreContract,
  restoreOriginalPublicationAdmission,
  tryReadReleaseDecisionArtifact,
} from "./release-ci-summary.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_REPOSITORY = "openclaw/openclaw";
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 12 * 60 * 60_000;
const DEFAULT_RECONCILE_TIMEOUT_MS = 60_000;
const DEFAULT_WATCH_POLL_MS = 60_000;
const DEFAULT_CHILD_MAX_ATTEMPTS = 2;
const PLAN_FILENAME = "full-release-execution-plan.json";

function requiredValue(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function positiveInteger(value, label) {
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return normalized;
}

function configuredTimeout(name, fallback) {
  return positiveInteger(process.env[name] || fallback, name);
}

function createOperationDeadline() {
  const deadline = Date.now() + configuredTimeout("OPENCLAW_FRV_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(deadline)) {
    throw new Error("FRV operation deadline is invalid");
  }
  return deadline;
}

function validateOperationDeadline(deadline) {
  if (!Number.isSafeInteger(deadline) || deadline < 1) {
    throw new Error("FRV operation deadline must be a positive integer");
  }
  return deadline;
}

function remainingOperationTime(deadline, label = "FRV operation") {
  const remaining = validateOperationDeadline(deadline) - Date.now();
  if (remaining < 1) {
    throw new Error(`${label} timed out`);
  }
  return remaining;
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {
    command,
    dryRun: false,
    failedOnly: false,
    json: false,
    repository: DEFAULT_REPOSITORY,
    runId: "",
  };
  const publicationRequested = argv.includes("--publication-run");
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (publicationRequested && seen.has(argument)) {
      throw new Error("duplicate publication status argument");
    }
    seen.add(argument);
    if (argument === "--run") {
      options.runId = requiredValue(argv[++index], "--run");
    } else if (argument === "--publication-run") {
      options.publicationRunId = requiredValue(argv[++index], "--publication-run");
    } else if (argument === "--repo") {
      options.repository = requiredValue(argv[++index], "--repo");
    } else if (argument === "--job") {
      options.job = requiredValue(argv[++index], "--job");
    } else if (argument === "--child") {
      options.child = requiredValue(argv[++index], "--child");
    } else if (argument === "--max-attempts") {
      options.maxAttempts = positiveInteger(argv[++index], "--max-attempts");
    } else if (argument === "--state") {
      options.statePath = requiredValue(argv[++index], "--state");
    } else if (argument === "--interval") {
      options.intervalMs = positiveInteger(argv[++index], "--interval") * 1000;
    } else if (argument === "--once") {
      options.once = true;
    } else if (argument === "--failed") {
      options.failedOnly = true;
    } else if (argument === "--restore") {
      options.restore = requiredValue(argv[++index], "--restore");
    } else if (argument === "--json") {
      options.json = true;
    } else if (argument === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (!["continue", "prioritize", "rerun", "status", "verify", "watch"].includes(command)) {
    throw new Error(
      "usage: pnpm frv <status|watch|continue|rerun|verify> --run <id> [--failed | --job <child>:<name> | --child <key|run-id> [--max-attempts <n>]] | pnpm frv prioritize --restore <record>",
    );
  }
  const restoring = command === "prioritize";
  if (restoring && options.restore === undefined) {
    // Release validation no longer pauses PR CI; only historical records remain.
    throw new Error("prioritize --run is retired; use prioritize --restore <record>");
  }
  if (restoring ? options.runId !== "" : !/^[1-9][0-9]*$/u.test(options.runId)) {
    throw new Error(
      restoring ? "--restore does not take --run" : "--run must be a positive decimal",
    );
  }
  if (options.restore !== undefined && !restoring) {
    throw new Error("--restore is valid only with prioritize");
  }
  if (command === "continue" && !options.failedOnly) {
    throw new Error("continue requires --failed");
  }
  if (command !== "continue" && options.failedOnly) {
    throw new Error("--failed is valid only with continue");
  }
  if (!["continue", "prioritize", "rerun"].includes(command) && options.dryRun) {
    throw new Error("--dry-run is valid only with continue, rerun, or prioritize");
  }
  if (command === "rerun") {
    if ((options.job === undefined) === (options.child === undefined)) {
      throw new Error("rerun requires exactly one of --job or --child");
    }
    if (options.job !== undefined) {
      parseJobSelector(options.job);
    }
  } else if (options.job !== undefined || options.child !== undefined) {
    throw new Error("--job and --child are valid only with rerun");
  }
  if (options.maxAttempts !== undefined && options.child === undefined) {
    throw new Error("--max-attempts is valid only with rerun --child");
  }
  if (
    command !== "watch" &&
    (options.statePath !== undefined || options.intervalMs !== undefined || options.once)
  ) {
    throw new Error("--state, --interval, and --once are valid only with watch");
  }
  if (publicationRequested) {
    if (
      !(
        command === "status" &&
        /^[1-9][0-9]*$/u.test(options.publicationRunId) &&
        Number.isSafeInteger(Number(options.publicationRunId)) &&
        Number.isSafeInteger(Number(options.runId)) &&
        /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository) &&
        options.repository.split("/").every((part) => part !== "." && part !== "..") &&
        options.repository.length <= 200
      )
    ) {
      throw new Error("invalid publication status arguments");
    }
  }
  return options;
}

function parseJobSelector(selector) {
  const match = /^([^:]+):(.+)$/u.exec(selector ?? "");
  if (!match || match[1].trim() !== match[1] || match[2].trim() !== match[2]) {
    throw new Error("--job requires an exact <child>:<job name> selector from frv status");
  }
  return { childKey: match[1], name: match[2] };
}

async function execCommand(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 60_000,
  });
  return result.stdout;
}

function execGh(args, options = {}) {
  return execCommand(resolvePlainGhBin(), args, {
    ...options,
    env: plainGhAuthenticatedEnv(),
  });
}

function verifierEvidenceNeedsRefresh(error) {
  if (!error || typeof error !== "object" || typeof error.stdout !== "string") {
    return false;
  }
  try {
    const failure = JSON.parse(error.stdout);
    return failure?.valid === false && failure.refreshable === true;
  } catch {
    return false;
  }
}

function isUnknownAllowEscapeSequencesFlag(error) {
  return (
    typeof error?.stderr === "string" &&
    error.stderr
      .replace(/\r\n?/gu, "\n")
      .split("\n")
      .includes("unknown flag: --allow-escape-sequences")
  );
}

async function execGhRead(args, options = {}) {
  for (let attempt = 1; ; attempt += 1) {
    const remaining =
      options.operationDeadline === undefined
        ? Number.MAX_SAFE_INTEGER
        : remainingOperationTime(options.operationDeadline);
    try {
      return await execGh(args, {
        ...options,
        timeoutMs: Math.min(options.timeoutMs ?? 60_000, remaining),
      });
    } catch (error) {
      if (
        attempt === 4 ||
        releaseGhRateLimitRetryAt(error) !== undefined ||
        classifyReleaseGhTransportError(error) !== "transient"
      ) {
        throw error;
      }
      await sleep(
        Math.min(
          attempt * 1000,
          5000,
          options.operationDeadline === undefined
            ? Number.MAX_SAFE_INTEGER
            : remainingOperationTime(options.operationDeadline),
        ),
      );
    }
  }
}

async function readGhApi(repository, path, args = [], options = {}, fresh = true) {
  // Rerun decisions require current attempts and jobs, not a relay's earlier snapshot.
  // Polling watchers keep the relay's own freshness policy.
  const include = !path.endsWith("/logs");
  const output = await execGhRead(
    [
      "api",
      ...(include ? ["--include"] : []),
      `repos/${repository}/${path}`,
      ...(fresh ? ["-H", "Cache-Control: max-age=0"] : []),
      ...args,
    ],
    options,
  );
  // gh emits a header block for each paginated response, even with --jq.
  // Keep successful JSON rows intact while retaining failed-response retry headers.
  return include
    ? output.replace(/^HTTP\/\d+(?:\.\d+)? [^\r\n]+\r?\n(?:[^\r\n]+\r?\n)*\r?\n/gmu, "").trim()
    : output.trim();
}

async function ghJson(repository, path, options, fresh) {
  return JSON.parse(await readGhApi(repository, path, [], options, fresh));
}

async function downloadExecutionPlan(repository, runId) {
  const directory = mkdtempSync(join(tmpdir(), "openclaw-frv-plan-"));
  try {
    try {
      await execGhRead([
        "run",
        "download",
        runId,
        "--repo",
        repository,
        "--name",
        `full-release-execution-plan-${runId}`,
        "--dir",
        directory,
      ]);
    } catch (error) {
      if (isReleaseGhArtifactMissingError(error)) {
        return undefined;
      }
      throw error;
    }
    const path = join(directory, PLAN_FILENAME);
    const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
    if (size < 1 || size > MAX_RELEASE_ARTIFACT_BYTES) {
      throw new Error("immutable execution plan artifact is missing or oversized");
    }
    return JSON.parse(readFileSync(path, "utf8"));
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function selectedChildren(plan) {
  return plan.children.filter((child) => child.selected);
}

function hasExactChildRunIdentity(child) {
  return (
    typeof child.runId === "string" &&
    /^[1-9][0-9]*$/u.test(child.runId) &&
    Number.isSafeInteger(child.runAttempt) &&
    child.runAttempt > 0
  );
}

function assertChildRunIdentity(child, run, repository = DEFAULT_REPOSITORY) {
  return validateReleaseChildRunProvenance(run, {
    ...child,
    plannedRunAttempt: child.runAttempt,
    repository,
  });
}

function exactParentJob(parentJobs, child, sourceParentAttempt) {
  const spec = releaseChildSpec(child.key);
  const matches = parentJobs.filter(
    (job) =>
      job.name === spec.parentJobName && Number(job.run_attempt) === Number(sourceParentAttempt),
  );
  if (
    matches.length !== 1 ||
    matches[0].status !== "completed" ||
    !["success", "failure"].includes(String(matches[0].conclusion))
  ) {
    throw new Error(`source parent dispatch job is missing or ambiguous: ${child.key}`);
  }
  return matches[0];
}

async function inspectArtifactProducers(producers, client, options) {
  return Promise.all(
    producers.map(async ({ request, runId, runAttempt }) => {
      const run = validateArtifactProducerRun(
        request,
        await client.getRun(runId, options),
        runId,
        runAttempt,
        {
          allowFailure: true,
          allowNewerAttempts: true,
        },
      );
      const active = run.status !== "completed";
      const passed = !active && run.conclusion === "success";
      return {
        key: `artifact:${request.stage}`,
        runId,
        plannedRunAttempt: Number(runAttempt),
        effectiveRunAttempt: Number(run.run_attempt),
        conclusion: String(run.conclusion ?? ""),
        status: active ? "active" : passed ? "passed" : "failed",
        passed,
        url: run.html_url,
      };
    }),
  );
}

async function inspectRecovery(plan, producers, client, options) {
  const [diagnostics, artifacts] = await Promise.all([
    inspectContinuation(plan, client, options),
    inspectArtifactProducers(producers, client, options),
  ]);
  return continuationStatus([...diagnostics.children, ...artifacts]);
}

function continuationStatus(children) {
  return {
    children,
    failed: children.filter((child) => child.status === "failed"),
    active: children.filter((child) => child.status === "active"),
    missing: children.filter((child) => child.status === "missing"),
    passed: children.filter((child) => child.status === "passed"),
  };
}

async function recheckArtifactProducers(
  producers,
  status,
  client,
  allowActiveProgress = false,
  options = {},
) {
  const current = await inspectArtifactProducers(producers, client, options);
  for (const observed of current) {
    const expected = status.children.find((child) => child.runId === observed.runId);
    if (
      !expected ||
      observed.effectiveRunAttempt !== expected.effectiveRunAttempt ||
      (!(allowActiveProgress && expected.status === "active") &&
        (observed.status !== expected.status || observed.conclusion !== expected.conclusion))
    ) {
      throw new Error(`Artifact producer changed during recovery: ${observed.runId}`);
    }
  }
}

async function npmRecoveryProducers(plan, parentJobs, client, repository, workflow, options) {
  // Older workflow revisions did not dispatch npm qualification independently.
  if (!workflow.includes("node scripts/full-release-artifacts.mjs resolve")) {
    return [];
  }
  const matches = parentJobs.filter(
    (job) =>
      job.name === "Prepare release npm artifacts" &&
      Number(job.run_attempt) === plan.parentRunAttempt,
  );
  if (matches.length !== 1) {
    throw new Error("Original npm dispatch job is missing or ambiguous");
  }
  const [job] = matches;
  if (job.conclusion === "skipped") {
    return [];
  }
  if (job.status !== "completed") {
    return undefined;
  }
  const log = stripVTControlCharacters(await client.getJobLog(job.id, options));
  const dispatches = [
    ...log.matchAll(
      /(?:^|\n)(?:\d{4}-\d\d-\d\dT\S+ )?Dispatched full-release-artifacts\.yml: https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/([1-9][0-9]*) \(attempt ([1-9][0-9]*)\)\r?(?=\n|$)/gu,
    ),
  ];
  if (
    dispatches.length !== 1 ||
    dispatches[0][1] !== repository ||
    !log.includes(`TARGET_SHA: ${plan.targetSha}`)
  ) {
    throw new Error("Original npm dispatch identity is unavailable or ambiguous");
  }
  return [
    {
      request: {
        stage: "npm",
        repository,
        dispatchId: `full-release-validation-${plan.parentRunId}-${plan.parentRunAttempt}-artifacts-npm`,
        toolingSha: plan.workflowSha,
        workflowRef: plan.workflowRef,
      },
      runId: dispatches[0][2],
      runAttempt: dispatches[0][3],
    },
  ];
}

function assertRootRunIdentity(run, source, allowNewerAttempt = false) {
  const attempt = Number(run.run_attempt);
  if (
    String(run.id) !== source.sourceRunId ||
    !Number.isSafeInteger(attempt) ||
    (allowNewerAttempt ? attempt < source.sourceRunAttempt : attempt !== source.sourceRunAttempt) ||
    run.display_title !== source.sourceDisplayTitle ||
    run.event !== source.sourceEvent ||
    String(run.path ?? "").split("@", 1)[0] !== source.sourceWorkflowPath ||
    run.head_branch !== source.sourceWorkflowRef ||
    run.head_sha !== source.sourceWorkflowSha ||
    run.repository?.full_name !== source.sourceRepository
  ) {
    throw Object.assign(new Error("source full release parent identity changed"), {
      code: "FRV_PARENT_PROVENANCE",
    });
  }
}

export async function preflightContinuation(
  plan,
  rootRunId,
  client,
  repository = DEFAULT_REPOSITORY,
  options = {},
) {
  if (plan.candidate?.producer.runId === String(rootRunId)) {
    throw new Error(
      "parent-owned sealed candidate artifacts do not survive parent reruns; start a fresh all-group FRV",
    );
  }
  if (plan.rerunGroup !== "all") {
    throw new Error("FRV continuation requires an all-group root");
  }
  const source = {
    sourceDisplayTitle: "Full Release Validation",
    sourceEvent: "workflow_dispatch",
    sourceRepository: repository,
    sourceRunAttempt: plan.parentRunAttempt,
    sourceRunId: String(rootRunId),
    sourceWorkflowPath: ".github/workflows/full-release-validation.yml",
    sourceWorkflowRef: plan.workflowRef,
    sourceWorkflowSha: plan.workflowSha,
  };
  const sourceRun = await client.getRunAttempt(
    source.sourceRunId,
    source.sourceRunAttempt,
    options,
  );
  assertRootRunIdentity(sourceRun, source);
  const parentJobs = await client.getParentJobs(source.sourceRunId, options);
  if (
    parentJobs.some(
      (job) =>
        Number(job.run_attempt) === source.sourceRunAttempt &&
        job.conclusion !== "skipped" &&
        /^(?:Prepare release npm artifacts|Prepare release Docker artifacts) \/ /u.test(
          job.name ?? "",
        ),
    )
  ) {
    throw new Error(
      "parent-owned publication artifacts do not survive parent reruns; start a fresh all-group FRV",
    );
  }
  const missingChildren = selectedChildren(plan)
    .filter((child) => !hasExactChildRunIdentity(child))
    .map((child) => child.key)
    .toSorted();
  if (missingChildren.length > 0) {
    throw new Error(
      `selected FRV children did not record exact run IDs and attempts: ${missingChildren.join(", ")}; start a fresh all-group FRV`,
    );
  }
  const resolveJobs = parentJobs.filter(
    (job) =>
      job.name === "Resolve target ref" &&
      Number(job.run_attempt) === Number(source.sourceRunAttempt),
  );
  if (resolveJobs.length !== 1 || resolveJobs[0].status !== "completed") {
    throw new Error("source full release input job is missing or ambiguous");
  }
  const resolveLog = await client.getJobLog(resolveJobs[0].id, options);
  if (
    !String(resolveLog).includes("RERUN_GROUP: all") ||
    !String(resolveLog).includes("FAIL_FAST: false") ||
    !String(resolveLog).includes(`TARGET_SHA: ${plan.targetSha}`)
  ) {
    throw new Error("source full release root is not an exact fail-fast-disabled all-group target");
  }
  const evidenceClient = client.getReleaseEvidenceClient();
  const workflow = evidenceClient.getWorkflowSource(plan.workflowSha);
  const sourceContract = publicationSourceContract(workflow);
  const registryContract = publicationAdmissionContract(workflow);
  if (
    plan.sourceAdmissionContract !== sourceContract ||
    plan.publicationAdmissionContract !== registryContract
  ) {
    throw new Error("continuation admission differs from its immutable source workflow contract");
  }
  const sourceAdmission = validatePublicationSourceBinding(plan, {
    sourceAdmissionContract: sourceContract,
    parentRunId: String(rootRunId),
    repository,
    targetSha: plan.targetSha,
  });
  validatePublicationAdmissionBinding(plan, { publicationAdmissionContract: registryContract });
  if (registryContract) {
    if (!releaseExecutionPlanRestoreContract(workflow)) {
      throw new Error(
        "frozen workflow cannot restore publication admission after a parent rerun; use a fresh parent",
      );
    }
    const original = await restoreOriginalPublicationAdmission({
      request: sourceAdmission,
      client: {
        ...evidenceClient,
        getWorkflowSource: (sha) =>
          sha === plan.workflowSha ? workflow : evidenceClient.getWorkflowSource(sha),
      },
    });
    const validated = validateReleaseExecutionPlanArtifact(plan, {
      parentRunId: String(rootRunId),
      sourceAdmissionContract: sourceContract,
      publicationAdmissionContract: registryContract,
    });
    if (validated.sha256 !== original.plan.sha256) {
      throw new Error("continuation differs from the authenticated original publication plan");
    }
  }
  const artifactProducers = await npmRecoveryProducers(
    plan,
    parentJobs,
    client,
    repository,
    workflow,
    options,
  );
  const childObservations = await Promise.all(
    selectedChildren(plan).map(async (child) => {
      const sourceParentAttempt = child.sourceParentAttempt ?? source.sourceRunAttempt;
      const parentJob = exactParentJob(parentJobs, child, sourceParentAttempt);
      const [childRun, parentLog] = await Promise.all([
        client.getRunAttempt(child.runId, child.runAttempt, options),
        client.getJobLog(parentJob.id, options),
      ]);
      return { child, childRun, parentLog };
    }),
  );
  for (const { child, parentLog } of childObservations) {
    validateReleaseChildDispatchBinding({
      child,
      log: parentLog,
      coveragePolicy: plan.coveragePolicy,
      plannedRunAttempt: child.runAttempt,
      repository,
      targetSha: plan.targetSha,
    });
  }
  for (const { child, childRun } of childObservations) {
    assertChildRunIdentity(child, childRun, repository);
  }
  return {
    ...sourceRun,
    artifactProducers: artifactProducers ?? [],
    pendingArtifactProducers: artifactProducers === undefined,
    parentBinding: source,
  };
}

async function readChildAttemptEvidence(child, client, options) {
  const repository = client.repository ?? DEFAULT_REPOSITORY;
  let source;
  let materializationDeadline;
  let materializationError;
  const assertReadBudget = () => {
    if (materializationDeadline !== undefined && Date.now() >= materializationDeadline) {
      throw materializationError;
    }
    if (options.operationDeadline !== undefined) {
      remainingOperationTime(options.operationDeadline);
    }
  };
  const readOptions = () => ({
    operationDeadline: materializationDeadline ?? options.operationDeadline,
  });
  const assertMaterializationRun = (run) => {
    if (
      source &&
      (JSON.stringify(runIdentity(run)) !== JSON.stringify(runIdentity(source)) ||
        Number(run.run_attempt) !== Number(source.run_attempt) ||
        run.triggering_actor?.login !== source.triggering_actor?.login)
    ) {
      throw new Error(`child changed during attempt materialization: ${child.key}`);
    }
  };
  while (true) {
    assertReadBudget();
    const run = await client.getRun(child.runId, readOptions());
    assertChildRunIdentity(child, run, repository);
    const effectiveRunAttempt = positiveInteger(run.run_attempt, `${child.key} run attempt`);
    assertMaterializationRun(run);
    const attempts = await Promise.all(
      Array.from({ length: effectiveRunAttempt - child.runAttempt + 1 }, async (_, index) => {
        const runAttempt = child.runAttempt + index;
        assertReadBudget();
        return {
          jobs: await client.getAttemptJobs(child.runId, runAttempt, readOptions()),
          runAttempt,
        };
      }),
    );
    if (run.status !== "completed" && attempts.at(-1)?.jobs.length === 0) {
      if (attempts.slice(0, -1).some((attempt) => attempt.jobs.length === 0)) {
        throw new Error(`child attempt evidence is gapped: ${child.key}`);
      }
      return { run };
    }
    try {
      const evidence = composeReleaseChildAttemptEvidence({
        attempts,
        expected: { ...child, plannedRunAttempt: child.runAttempt, repository },
        run,
      });
      if (source) {
        assertReadBudget();
        const current = await client.getRun(child.runId, readOptions());
        assertChildRunIdentity(child, current, repository);
        assertMaterializationRun(current);
        if (
          run.status === "completed" &&
          (current.status !== run.status || current.conclusion !== run.conclusion)
        ) {
          throw new Error(`child changed during attempt materialization: ${child.key}`);
        }
      }
      return { run, evidence };
    } catch (error) {
      // GitHub briefly returns overlapping job identities while a new attempt
      // materializes. Never normalize those rows into accepted evidence.
      if (
        error?.code !== "FRV_DUPLICATE_JOB_IDENTITY" ||
        error.runAttempt !== effectiveRunAttempt ||
        effectiveRunAttempt <= child.runAttempt
      ) {
        throw error;
      }
      source ??= run;
      materializationError = error;
      materializationDeadline ??= Math.min(
        options.operationDeadline ?? Number.MAX_SAFE_INTEGER,
        Date.now() +
          configuredTimeout("OPENCLAW_FRV_RECONCILE_TIMEOUT_MS", DEFAULT_RECONCILE_TIMEOUT_MS),
      );
      const remaining = materializationDeadline - Date.now();
      if (remaining <= 0) {
        throw error;
      }
      await sleep(Math.min(configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS), remaining));
    }
  }
}

export async function inspectContinuation(plan, client, options = {}) {
  const children = await Promise.all(
    selectedChildren(plan).map(async (child) => {
      if (!hasExactChildRunIdentity(child)) {
        return {
          compositeJobsSha256: "",
          conclusion: "",
          effectiveRunAttempt: null,
          key: child.key,
          passed: false,
          plannedRunAttempt: child.runAttempt ?? null,
          runId: String(child.runId ?? ""),
          status: "missing",
          url: String(child.url ?? ""),
        };
      }
      const { run, evidence } = await readChildAttemptEvidence(child, client, options);
      const effectiveRunAttempt = Number(run.run_attempt);
      if (!evidence) {
        return {
          compositeJobsSha256: "",
          conclusion: String(run.conclusion ?? ""),
          effectiveRunAttempt,
          key: child.key,
          passed: false,
          plannedRunAttempt: child.runAttempt,
          runId: child.runId,
          status: "active",
          url: String(run.html_url ?? child.url ?? ""),
        };
      }
      const active = run.status !== "completed";
      const policyChild = {
        conclusion: run.conclusion,
        jobs: evidence.jobs,
        key: child.key,
        runId: child.runId,
        status: run.status,
      };
      const passed = !active && terminalPolicyPass(policyChild);
      return {
        compositeJobsSha256: evidence.compositeJobsSha256,
        conclusion: String(run.conclusion ?? ""),
        dispatchActor: evidence.dispatchActor,
        effectiveRunAttempt,
        jobs: evidence.jobs,
        key: child.key,
        passed,
        plannedRunAttempt: child.runAttempt,
        repository: evidence.repository,
        runId: child.runId,
        status: active ? "active" : passed ? "passed" : "failed",
        triggeringActor: evidence.triggeringActor,
        url: String(run.html_url ?? child.url ?? ""),
      };
    }),
  );
  return continuationStatus(children);
}

async function inspectQualificationStatus(plan, runId, client) {
  const operationDeadline = createOperationDeadline();
  let status;
  let parent;
  let jobs;
  try {
    status = await inspectContinuation(plan, client, { operationDeadline });
    [parent, jobs] = await Promise.all([
      client.getRun(runId, { operationDeadline }),
      client.getParentJobs(runId, { operationDeadline }),
    ]);
  } catch (error) {
    return {
      ...(status ?? continuationStatus([])),
      collectionComplete: false,
      qualification: { state: "observation-unavailable", evidence: "unavailable" },
      drain: {
        status: "unknown",
        conclusion: "",
        activeRunIds: status?.active.map((child) => child.runId) ?? [],
      },
      decision: null,
      candidate: { sha: plan.targetSha, ref: null, tipSha: null, state: "unknown" },
      observationErrors: [
        `GitHub observation unavailable (${classifyReleaseGhTransportError(error)})`,
      ],
      nextCommand: `pnpm frv watch --run ${runId} --once`,
    };
  }
  if (String(parent.id) !== runId || parent.head_sha !== plan.workflowSha) {
    throw new Error("status parent identity differs from the immutable execution plan");
  }
  const currentJobs = jobs.filter((job) => Number(job.run_attempt) === Number(parent.run_attempt));
  const drainJobs = currentJobs.filter((job) => job.name === "Diagnostic Drain");
  const drainJob = drainJobs.length === 1 ? drainJobs[0] : undefined;
  const drain = {
    status: drainJob?.status ?? "unknown",
    conclusion: drainJob?.conclusion ?? "",
    activeRunIds: status.active.map((child) => child.runId),
  };
  const observationErrors = [];
  if (parent.status === "completed" && !drainJob) {
    observationErrors.push("Diagnostic Drain observation unavailable");
  }
  let decision;
  try {
    const artifact = tryReadReleaseDecisionArtifact(
      { attempt: parent.run_attempt, headSha: parent.head_sha },
      runId,
      client.repository,
    );
    if (artifact) {
      decision = validateReleaseStateArtifact(artifact, { executionPlan: plan }, "decision");
    } else if (
      parent.status === "completed" ||
      currentJobs.some((job) => job.name === "Release Decision" && job.status === "completed")
    ) {
      observationErrors.push("Decision evidence unavailable");
    }
  } catch {
    observationErrors.push("Decision evidence unavailable or invalid");
  }
  let evidence = "pending";
  if (parent.status === "completed") {
    evidence = "not-accepted";
    if (parent.conclusion === "success") {
      try {
        const attempts = await freezeVerificationAttempts(
          plan,
          runId,
          status,
          client,
          operationDeadline,
        );
        evidence = (await client.verifySeal(runId, plan, operationDeadline, attempts))
          ? "accepted"
          : "needs-refresh";
      } catch {
        evidence = "unavailable";
        observationErrors.push("Seal verification unavailable; run frv verify for details");
      }
    }
  }
  const qualification = {
    state:
      evidence === "accepted"
        ? "passed"
        : evidence === "unavailable"
          ? "observation-unavailable"
          : decision && !["qualifying", "passed"].includes(decision.state)
            ? "blocked"
            : parent.status === "completed" || status.failed.length || status.missing.length
              ? "blocked"
              : "running",
    evidence,
  };
  const ref =
    plan.sourceAdmission?.targetContextRef ?? plan.qualificationInputs?.target_context_ref;
  let candidate = { sha: plan.targetSha, ref: ref ?? null, tipSha: null, state: "unknown" };
  if (ref && !/^[a-f0-9]{40}$/u.test(ref)) {
    try {
      const fullRef = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
      const tip = await client.getRef(fullRef, { operationDeadline });
      candidate = {
        sha: plan.targetSha,
        ref,
        tipSha: tip.object.sha,
        state: tip.object.sha === plan.targetSha ? "current" : "superseded",
      };
    } catch {
      observationErrors.push("Candidate tip observation unavailable");
    }
  }
  const nextCommand = `pnpm frv ${
    status.active.length || parent.status !== "completed"
      ? "watch"
      : qualification.state === "blocked"
        ? "continue --failed --dry-run"
        : "verify"
  } --run ${runId}`;
  return {
    ...status,
    collectionComplete: observationErrors.length === 0,
    qualification,
    drain,
    decision: decision ?? null,
    candidate,
    observationErrors,
    nextCommand,
  };
}

export function createClient(repository, dependencies = {}) {
  let releaseEvidenceClient;
  const fresh = dependencies.cachedReads !== true;
  const apiJson =
    dependencies.apiJson ?? ((path, options) => ghJson(repository, path, options, fresh));
  const apiText =
    dependencies.apiText ??
    ((path, jq, extraArgs = [], options = {}) =>
      readGhApi(
        repository,
        path,
        [...(jq ? ["--paginate", "--jq", jq] : []), ...extraArgs],
        options,
        fresh,
      ));
  const mutate = dependencies.mutate ?? ((args) => execGh(args));
  const rerun = (runId, action) =>
    mutate(["api", "-X", "POST", `repos/${repository}/actions/runs/${runId}/${action}`]);
  const execute = dependencies.execCommand ?? execCommand;
  const readJobs = async (path, options) => {
    const output = await apiText(path, ".jobs[] | @json", [], options);
    return output
      ? output
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  };
  const verify = async (runId, plan, operationDeadline, expectedRunAttempts) => {
    const sourceSha = plan.trustedWorkflow?.sha;
    return execute(
      process.execPath,
      [
        "scripts/release-ci-summary.mjs",
        "--validate-run",
        runId,
        "--repo",
        repository,
        "--trusted-workflow-ref",
        plan.trustedWorkflow?.ref ?? "main",
        "--trusted-workflow-full-ref",
        plan.trustedWorkflow?.fullRef ?? "refs/heads/main",
        "--trusted-workflow-sha",
        sourceSha,
        "--verifier-source-sha",
        sourceSha,
        "--verifier-source-file",
        "scripts/release-ci-summary.mjs",
        ...(expectedRunAttempts === undefined
          ? []
          : ["--expected-run-attempts-json", JSON.stringify(expectedRunAttempts)]),
        "--json",
      ],
      {
        timeoutMs: remainingOperationTime(
          operationDeadline ?? createOperationDeadline(),
          "FRV verification",
        ),
      },
    );
  };
  return {
    repository,
    getReleaseEvidenceClient() {
      releaseEvidenceClient ??= createReleaseEvidenceClient(repository);
      return releaseEvidenceClient;
    },
    getAttemptJobs:
      dependencies.getAttemptJobs ??
      ((runId, runAttempt, options) =>
        readJobs(`actions/runs/${runId}/attempts/${runAttempt}/jobs?per_page=100`, options)),
    getRef(fullRef, options) {
      const ref = fullRef
        .replace(/^refs\//u, "")
        .split("/")
        .map(encodeURIComponent)
        .join("/");
      return apiJson(`git/ref/${ref}`, options);
    },
    getRun(runId, options) {
      return apiJson(`actions/runs/${runId}`, options);
    },
    getRunAttempt(runId, runAttempt, options) {
      return apiJson(`actions/runs/${runId}/attempts/${runAttempt}`, options);
    },
    getParentJobs: (runId, options) =>
      readJobs(`actions/runs/${runId}/jobs?filter=all&per_page=100`, options),
    async getJobLog(jobId, options) {
      // Octopool's gh shim refuses log bodies with terminal escape sequences even off a TTY;
      // real gh ignores the flag off-TTY, so the controller works with either binary.
      const path = `actions/jobs/${jobId}/logs`;
      try {
        return await apiText(path, undefined, ["--allow-escape-sequences"], options);
      } catch (error) {
        // gh before 2.97 rejects this flag before issuing the protected request.
        if (!isUnknownAllowEscapeSequencesFlag(error)) {
          throw error;
        }
        return apiText(path, undefined, [], options);
      }
    },
    rerunFailed: (runId) => rerun(runId, "rerun-failed-jobs"),
    rerunRun: (runId) => rerun(runId, "rerun"),
    listRuns: (query) => listReleasePriorityRuns(query, apiJson, apiText),
    async getVariable(name) {
      try {
        return String((await apiJson(`actions/variables/${name}`)).value ?? "");
      } catch (error) {
        if (/HTTP 404|Not Found/u.test(String(error?.stderr ?? error?.message ?? ""))) {
          return "";
        }
        throw error;
      }
    },
    deleteVariable: (name) => mutate(["variable", "delete", name, "--repo", repository]),
    rerunJob: (jobId) =>
      mutate(["api", "-X", "POST", `repos/${repository}/actions/jobs/${jobId}/rerun`]),
    rerunParent: (runId) => rerun(runId, "rerun"),
    verify,
    async verifySeal(runId, plan, operationDeadline, expectedRunAttempts) {
      try {
        await verify(runId, plan, operationDeadline, expectedRunAttempts);
        return true;
      } catch (error) {
        if (verifierEvidenceNeedsRefresh(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

function controllerRunAttempt(run, sourceAttempt, expectedAttempt) {
  const runId = String(run.id);
  const observedAttempt = positiveInteger(run.run_attempt, `${runId} run attempt`);
  if (observedAttempt < sourceAttempt) {
    throw new Error(`rerun source ${runId} attempt regressed`);
  }
  if (observedAttempt > expectedAttempt) {
    throw new Error(`controller-owned run ${runId} advanced past attempt ${expectedAttempt}`);
  }
  return observedAttempt;
}

async function waitForTerminal(runIds, client, operationDeadline, expectedAttempts = new Map()) {
  const pollMs = configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS);
  while (Date.now() < operationDeadline) {
    const runs = await Promise.all(
      runIds.map((runId) => client.getRun(runId, { operationDeadline })),
    );
    const ready = runs.every((run) => {
      const runId = String(run.id);
      const expectedAttempt = expectedAttempts.get(runId);
      if (expectedAttempt === undefined) {
        return run.status === "completed";
      }
      const observedAttempt = controllerRunAttempt(run, expectedAttempt - 1, expectedAttempt);
      return run.status === "completed" && observedAttempt === expectedAttempt;
    });
    if (ready) {
      return runs;
    }
    await sleep(Math.min(pollMs, remainingOperationTime(operationDeadline)));
  }
  throw new Error(`timed out waiting for runs: ${runIds.join(", ")}`);
}

async function reconcileAttemptStarts(
  minimumAttempts,
  priorRuns,
  client,
  mutationResults,
  operationDeadline,
  onStarted,
) {
  const reconcileDeadline = Math.min(
    operationDeadline,
    Date.now() +
      configuredTimeout("OPENCLAW_FRV_RECONCILE_TIMEOUT_MS", DEFAULT_RECONCILE_TIMEOUT_MS),
  );
  const hardFailures = mutationResults.filter(
    (result) =>
      result.status === "rejected" && classifyReleaseGhTransportError(result.reason) === "hard",
  );
  const pending = new Set(
    [...minimumAttempts.keys()].filter(
      (_, index) => !hardFailures.includes(mutationResults[index]),
    ),
  );
  while (pending.size > 0 && Date.now() < reconcileDeadline) {
    const runs = await Promise.all(
      [...pending].map((runId) => client.getRun(runId, { operationDeadline: reconcileDeadline })),
    );
    for (const run of runs) {
      const runId = String(run.id);
      const priorRun = priorRuns.get(runId);
      if (JSON.stringify(runIdentity(run)) !== JSON.stringify(runIdentity(priorRun))) {
        throw new Error(`rerun source ${runId} changed during mutation reconciliation`);
      }
      const sourceAttempt = positiveInteger(priorRun.run_attempt, `${runId} source run attempt`);
      const expectedAttempt = minimumAttempts.get(runId);
      const observedAttempt = controllerRunAttempt(run, sourceAttempt, expectedAttempt);
      if (observedAttempt === expectedAttempt) {
        onStarted(run);
        pending.delete(runId);
      }
    }
    if (pending.size > 0) {
      const remainingReconcileTime = reconcileDeadline - Date.now();
      if (remainingReconcileTime < 1) {
        break;
      }
      await sleep(
        Math.min(
          configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS),
          remainingReconcileTime,
        ),
      );
    }
  }
  if (pending.size > 0) {
    const runIds = [...minimumAttempts.keys()];
    const failures = [...pending].flatMap((runId) => {
      const result = mutationResults[runIds.indexOf(runId)];
      if (result?.status !== "rejected") {
        return [];
      }
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      return [`${runId}: ${reason}`];
    });
    throw new Error(
      `rerun mutation did not produce an observable newer attempt for ${[...pending].join(
        ", ",
      )}${failures.length > 0 ? ` (${failures.join("; ")})` : ""}`,
    );
  }
  if (hardFailures[0]) {
    throw hardFailures[0].reason;
  }
  remainingOperationTime(operationDeadline);
}

function runIdentity(run) {
  return {
    actor: String(run.actor?.login ?? ""),
    displayTitle: String(run.display_title ?? ""),
    event: String(run.event ?? ""),
    headBranch: String(run.head_branch ?? ""),
    headSha: String(run.head_sha ?? ""),
    id: String(run.id),
    path: String(run.path ?? ""),
    repository: String(run.repository?.full_name ?? run.repository ?? ""),
  };
}

function exactTerminalRunState(run, runId) {
  const state = {
    ...runIdentity(run),
    conclusion: run.conclusion ?? null,
    runAttempt: positiveInteger(run.run_attempt, `${runId} run attempt`),
    triggeringActor: String(run.triggering_actor?.login ?? ""),
  };
  if (state.id !== runId || String(run.status ?? "") !== "completed") {
    throw new Error(`rerun source ${runId} is no longer the exact terminal run`);
  }
  return state;
}

async function freezeVerificationAttempts(plan, rootRunId, status, client, operationDeadline) {
  // Artifact producers are checked independently around verification; the
  // manifest verifier consumes only parent and selected diagnostic run IDs.
  const diagnosticRunIds = new Set(selectedChildren(plan).map((child) => child.runId));
  const expectedRunAttempts = new Map(
    status.children
      .filter((child) => diagnosticRunIds.has(child.runId))
      .map((child) => [child.runId, child.effectiveRunAttempt]),
  );
  // Reuse verification rereads its root and selected parent manifests too.
  const parentRunIds = new Set([
    rootRunId,
    ...(plan.evidenceReuse?.requested
      ? [plan.evidenceReuse.rootRunId, plan.evidenceReuse.selectedRunId]
      : []),
  ]);
  for (const parentRunId of parentRunIds) {
    const run = await client.getRun(parentRunId, { operationDeadline });
    if (String(run.id) !== parentRunId) {
      throw new Error(`verification parent run identity changed: ${parentRunId}`);
    }
    const terminal = parentRunId === rootRunId ? exactTerminalRunState(run, rootRunId) : undefined;
    if (terminal && terminal.conclusion !== "success") {
      throw new Error(`final parent rerun failed: ${rootRunId}`);
    }
    expectedRunAttempts.set(
      parentRunId,
      terminal?.runAttempt ?? positiveInteger(run.run_attempt, `${parentRunId} run attempt`),
    );
  }
  return Object.fromEntries(expectedRunAttempts.entries());
}

async function selectedRerunJob(child, target, client, operationDeadline) {
  const accepted = child.jobs?.find((job) => job.name === target.name);
  const jobs = await client.getAttemptJobs(child.runId, accepted.acceptedRunAttempt, {
    operationDeadline,
  });
  const matches = jobs.filter((job) => job.name === target.name && job.conclusion !== "skipped");
  if (matches.length !== 1) {
    throw new Error(
      `job identity changed before rerun dispatch: ${target.childKey}:${target.name}`,
    );
  }
  const [job] = matches;
  const id = positiveInteger(job.id, "rerun job id");
  if (
    job.status !== accepted.status ||
    job.conclusion !== accepted.conclusion ||
    String(job.html_url ?? "") !== accepted.url ||
    String(job.started_at ?? "") !== accepted.startedAt ||
    String(job.completed_at ?? "") !== accepted.completedAt ||
    (job.run_id !== undefined && String(job.run_id) !== child.runId) ||
    (job.run_attempt !== undefined && Number(job.run_attempt) !== accepted.acceptedRunAttempt)
  ) {
    throw new Error(
      `job identity changed before rerun dispatch: ${target.childKey}:${target.name}`,
    );
  }
  return { id, name: target.name, acceptedRunAttempt: accepted.acceptedRunAttempt };
}

export async function clearReleasePriority(client, parentRunId) {
  if ((await client.getVariable(RELEASE_PRIORITY_VARIABLE)) !== String(parentRunId)) {
    return false;
  }
  await client.deleteVariable(RELEASE_PRIORITY_VARIABLE);
  return true;
}

// Raw discovery facts bind dispatch without changing legacy pause records.
function restoreRunFacts(run) {
  const described = describeRun(run);
  if (
    !Number.isSafeInteger(run.id) ||
    run.id < 1 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt < 1 ||
    !Number.isSafeInteger(run.workflow_id) ||
    run.workflow_id < 1 ||
    !described.headBranch ||
    typeof run.head_sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(run.head_sha) ||
    !Number.isFinite(Date.parse(run.created_at)) ||
    described.lane.startsWith("run:") ||
    (run.pull_requests?.length ?? 0) > 1
  ) {
    throw new Error("Incomplete release-priority run identity: " + run.id);
  }
  return JSON.stringify([
    described.id,
    described.name,
    described.lane,
    described.event,
    described.headBranch,
    run.head_repository?.id,
    run.workflow_id,
    run.head_sha,
    run.created_at,
    run.run_attempt,
    run.status,
    run.conclusion,
  ]);
}

async function canRestoreRun(expected, record, client) {
  const facts = restoreRunFacts(expected);
  const current = await client.getRun(String(expected.id));
  if (restoreRunFacts(current) !== facts || !isDeferrableRun(current, record.parentRunId)) {
    return false;
  }
  if (current.status !== "completed") {
    return false;
  }
  if (current.conclusion !== "cancelled") {
    if (!selectDeferredRunCandidates([current], record).length) {
      return false;
    }
    if (
      current.name === "CI" &&
      !isDeferredCiJobSet(await client.getAttemptJobs(String(current.id), current.run_attempt))
    ) {
      return false;
    }
  }
  // Finish awaited attempt/job work before this last, branch-scoped inventory.
  // It includes the candidate itself, so both its exact attempt and its lane are
  // revalidated together. Reuse complete capped discovery, not a first-page probe.
  const query = new URLSearchParams({
    created: ">=" + expected.created_at,
    branch: expected.head_branch,
  });
  const latest = await client.listRuns(query.toString());
  const candidate = latest.find((run) => String(run.id) === String(expected.id));
  if (!candidate || restoreRunFacts(candidate) !== facts) {
    return false;
  }
  const lane = describeRun(expected).lane;
  for (const run of latest) {
    if (
      run.id <= expected.id ||
      run.name !== expected.name ||
      !isDeferrableRun(run, record.parentRunId)
    ) {
      continue;
    }
    // Missing PR metadata cannot prove independence for the same source branch.
    // Distinct PRs (including forks with identical branch names) remain independent.
    const otherLane = describeRun(run).lane;
    if (
      otherLane === lane ||
      otherLane.startsWith("run:") ||
      (run.pull_requests?.length ?? 0) > 1 ||
      (run.head_repository?.id === expected.head_repository?.id &&
        (!lane.startsWith("pr:") || !otherLane.startsWith("pr:")))
    ) {
      return false;
    }
  }
  // GitHub has no compare-and-rerun API. This narrows, but cannot atomically
  // close, races during that last inventory read or between its response and the POST.
  return true;
}

export async function restoreReleasePriority(recordPath, client, options = {}) {
  const record = readReleasePriorityRecord(recordPath);
  // Close the pause window first so nothing defers while the batch is collected.
  const cleared = options.dryRun ? false : await clearReleasePriority(client, record.parentRunId);
  const runs = await client.listRuns(`created=${encodeURIComponent(`>=${record.recordedAt}`)}`);
  const deferred = [];
  for (const run of selectDeferredRunCandidates(runs, record)) {
    if (
      run.conclusion === "skipped" ||
      isDeferredCiJobSet(await client.getAttemptJobs(String(run.id), run.run_attempt))
    ) {
      deferred.push(describeRun(run));
    }
  }
  const observed = new Map(runs.map((run) => [String(run.id), run]));
  const cancelled = [];
  for (const saved of record.cancelled) {
    // Older records predate lane identity, and a prior restore can have rerun the same ID.
    const current = observed.get(saved.id) ?? (await client.getRun(saved.id));
    if (String(current.id) !== saved.id) {
      throw new Error(`Cancelled workflow run identity changed: ${saved.id}`);
    }
    observed.set(saved.id, current);
    if (current.status === "completed" && current.conclusion === "cancelled") {
      cancelled.push(describeRun(current));
    }
  }
  const candidates = [...cancelled, ...deferred];
  const eligible = new Set(candidates.map((run) => run.id));
  // Manual dispatches have independent concurrency and cannot replace a PR check.
  const laneRuns = runs.filter((run) => isDeferrableRun(run, record.parentRunId)).map(describeRun);
  // A newer active or already-executed PR run owns its lane even when it was not deferred.
  const rerun = selectLatestRunsPerLane([...candidates, ...laneRuns]).filter((run) =>
    eligible.has(run.id),
  );
  if (options.dryRun) {
    return { action: "would-restore", deferred, rerun };
  }
  const failures = [];
  const skipped = [];
  const attempted = [];
  for (const run of rerun) {
    try {
      if (!(await canRestoreRun(observed.get(run.id), record, client))) {
        skipped.push(run);
        continue;
      }
      attempted.push(run);
      await client.rerunRun(run.id);
    } catch (error) {
      failures.push(`${run.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { action: "restored", cleared, failures, rerun: attempted, skipped };
}

// A sealed parent releases hosted-runner priority; a failure here never undoes the seal.
async function releaseSealedPriority(client, parentRunId) {
  try {
    if (await clearReleasePriority(client, parentRunId)) {
      console.log(`[frv] cleared ${RELEASE_PRIORITY_VARIABLE} (${parentRunId})`);
    }
  } catch (error) {
    console.warn(
      `[frv] ${RELEASE_PRIORITY_VARIABLE} not cleared: ${error instanceof Error ? error.message : String(error)}; run pnpm frv prioritize --restore <record>`,
    );
  }
}

function resolveRerunTarget(plan, options) {
  if (options.job !== undefined) {
    const target = parseJobSelector(options.job);
    if (!selectedChildren(plan).some((child) => child.key === target.childKey)) {
      throw new Error(`job selector names an unselected child: ${target.childKey}`);
    }
    return target;
  }
  if (options.child === undefined) {
    return undefined;
  }
  const match = selectedChildren(plan).find(
    (child) => child.key === options.child || child.runId === options.child,
  );
  if (!match) {
    throw new Error(
      `--child ${options.child} is not a selected FRV child; artifact producers recover through pnpm frv continue --failed`,
    );
  }
  return {
    childKey: match.key,
    maxAttempts: options.maxAttempts ?? DEFAULT_CHILD_MAX_ATTEMPTS,
  };
}

async function planChildRerun(child, target, client, operationDeadline) {
  const used = child.effectiveRunAttempt - child.plannedRunAttempt + 1;
  if (used >= target.maxAttempts) {
    throw new Error(
      `${child.key} already used ${used} of ${target.maxAttempts} attempts; raise --max-attempts only for a named flaky job`,
    );
  }
  const plan = planReleaseChildRerun({ childKey: child.key, jobs: child.jobs });
  const latest = await client.getAttemptJobs(child.runId, child.effectiveRunAttempt, {
    operationDeadline,
  });
  const failedJobs = plan.failed.map((name) => {
    const observed = latest.find((job) => job.name === name);
    return {
      labels: Array.isArray(observed?.labels) ? observed.labels.map(String) : [],
      name,
      runner: String(observed?.runner_name ?? ""),
    };
  });
  const runnerBackend = client.getVariable
    ? await client.getVariable("OPENCLAW_CI_RUNNER_BACKEND").catch(() => "unknown")
    : "unknown";
  // The producer rerun also reruns every dependent consumer in the same new attempt.
  const job =
    plan.mode === "producer"
      ? await selectedRerunJob(
          child,
          { childKey: child.key, name: plan.producer },
          client,
          operationDeadline,
        )
      : undefined;
  return { ...plan, failedJobs, job, runnerBackend };
}

function reportChildRerun(child, rerun, log) {
  log(
    rerun.mode === "producer"
      ? `[frv] ${child.key} run ${child.runId} attempt ${child.effectiveRunAttempt}: rerunning green producer "${rerun.producer}" and its dependents; its consumers bind the producer's run attempt`
      : `[frv] ${child.key} run ${child.runId} attempt ${child.effectiveRunAttempt}: rerunning failed jobs`,
  );
  for (const job of rerun.failedJobs) {
    log(
      `[frv]   failed: ${job.name} [${job.labels.join(",") || "no labels"}]${job.runner ? ` ${job.runner}` : ""}`,
    );
    if (
      rerun.runnerBackend === "github" &&
      job.labels.some((label) => label.startsWith("blacksmith-"))
    ) {
      log(
        `[frv]   warning: OPENCLAW_CI_RUNNER_BACKEND=github may move ${job.name} off ${job.labels.join(",")}`,
      );
    }
  }
  log(`[frv]   OPENCLAW_CI_RUNNER_BACKEND=${rerun.runnerBackend || "(unset)"}`);
}

function duplicateJobNames(jobs) {
  const seen = new Set();
  const duplicates = new Set();
  for (const job of jobs) {
    if (!(job.status === "completed" && job.conclusion === "skipped")) {
      (seen.has(job.name) ? duplicates : seen).add(job.name);
    }
  }
  return [...duplicates].toSorted((left, right) => left.localeCompare(right));
}

// A 5xx rerun storm can leave duplicate queued jobs without runners in the new attempt.
async function verifyRerunAttemptJobs(child, runAttempt, client, operationDeadline) {
  const deadline = Math.min(
    operationDeadline,
    Date.now() +
      configuredTimeout("OPENCLAW_FRV_RECONCILE_TIMEOUT_MS", DEFAULT_RECONCILE_TIMEOUT_MS),
  );
  while (true) {
    const jobs = await client.getAttemptJobs(child.runId, runAttempt, { operationDeadline });
    const duplicates = duplicateJobNames(jobs);
    if (jobs.length > 0 && duplicates.length === 0) {
      return;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(
        duplicates.length > 0
          ? `${child.key} run ${child.runId} attempt ${runAttempt} holds duplicate jobs: ${duplicates.join(", ")}; cancel that attempt before another rerun`
          : `${child.key} run ${child.runId} attempt ${runAttempt} exposed no jobs; inspect it before another rerun`,
      );
    }
    await sleep(Math.min(configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS), remaining));
  }
}

export async function continueFailed(plan, rootRunId, reader, options = {}) {
  const operationDeadline =
    options.operationDeadline === undefined
      ? createOperationDeadline()
      : validateOperationDeadline(options.operationDeadline);
  const ownedAttempts = new Map();
  const target = resolveRerunTarget(plan, options);
  const runKeys = new Map(selectedChildren(plan).map((child) => [child.runId, child.key]));
  runKeys.set(String(rootRunId), "parent");
  const reported = new Map();
  const log = options.log ?? console.error;
  const report = (run, started = false) => {
    const key = runKeys.get(String(run.id));
    if (!key) {
      return;
    }
    const message = formatRunProgress(key, run, started ? "started" : undefined);
    const previous = reported.get(String(run.id));
    const now = Date.now();
    if (
      started ||
      previous?.message !== message ||
      (run.status !== "completed" && now - previous.at >= 5 * 60_000)
    ) {
      log(
        formatProgressEvent("continue", {
          message: !started && run.status !== "completed" ? `waiting for ${message}` : message,
          url: `https://github.com/${client.repository ?? DEFAULT_REPOSITORY}/actions/runs/${run.id}/attempts/${run.run_attempt}`,
        }),
      );
      if (!started) {
        reported.set(String(run.id), { message, at: now });
      }
    }
  };
  const getRun = reader.getRun.bind(reader);
  const client = {
    ...reader,
    getRun: async (...args) => {
      const run = await getRun(...args);
      report(run);
      return run;
    },
  };
  const initial = await preflightContinuation(
    plan,
    rootRunId,
    client,
    client.repository ?? DEFAULT_REPOSITORY,
    { operationDeadline },
  );
  let { artifactProducers, pendingArtifactProducers } = initial;
  const { parentBinding } = initial;
  const reruns = [];
  let status;
  while (true) {
    for (const producer of artifactProducers) {
      runKeys.set(producer.runId, `artifact:${producer.request.stage}`);
    }
    status = await inspectRecovery(plan, artifactProducers, client, { operationDeadline });
    for (const child of status.children) {
      const expectedAttempt = ownedAttempts.get(child.runId);
      if (expectedAttempt !== undefined) {
        controllerRunAttempt(
          { id: child.runId, run_attempt: child.effectiveRunAttempt },
          expectedAttempt,
          expectedAttempt,
        );
      }
    }
    let ready = target ? [] : status.failed.filter((child) => !ownedAttempts.has(child.runId));
    if (target) {
      const selected = status.children.find((child) => child.key === target.childKey);
      if (selected.status !== "active" && !ownedAttempts.has(selected.runId)) {
        if (target.name === undefined) {
          if (selected.status !== "failed") {
            throw new Error(`child ${selected.key} is ${selected.status}; nothing to rerun`);
          }
        } else {
          const job = selected.jobs?.find((entry) => entry.name === target.name);
          if (!job) {
            throw new Error(`job selector does not match an executed job: ${options.job}`);
          }
          if (job.status !== "completed" || !job.conclusion || job.conclusion === "skipped") {
            throw new Error(`job selector is not an executed terminal job: ${options.job}`);
          }
        }
        ready = [selected];
      }
    }
    if (ready.length > 0) {
      const childRerun =
        target && target.name === undefined
          ? await planChildRerun(ready[0], target, client, operationDeadline)
          : undefined;
      if (options.dryRun) {
        if (target?.name !== undefined) {
          await selectedRerunJob(ready[0], target, client, operationDeadline);
        }
        return { action: "would-rerun", ...(childRerun ? { childRerun } : {}), status };
      }
      if (childRerun) {
        reportChildRerun(ready[0], childRerun, options.log ?? console.error);
      }
      const requests = await Promise.all(
        ready.map(async (child) => {
          const job = childRerun
            ? childRerun.job
            : target
              ? await selectedRerunJob(child, target, client, operationDeadline)
              : undefined;
          return { child, job };
        }),
      );
      const priorRuns = new Map(
        await Promise.all(
          requests.map(async ({ child }) => {
            const run = await client.getRun(child.runId, { operationDeadline });
            const producer = artifactProducers.find((entry) => entry.runId === child.runId);
            if (producer) {
              validateArtifactProducerRun(
                producer.request,
                run,
                producer.runId,
                child.effectiveRunAttempt,
                { allowFailure: true },
              );
            } else {
              assertChildRunIdentity(
                selectedChildren(plan).find((entry) => entry.runId === child.runId),
                run,
                client.repository ?? DEFAULT_REPOSITORY,
              );
            }
            const terminal = exactTerminalRunState(run, child.runId);
            if (
              terminal.runAttempt !== child.effectiveRunAttempt ||
              terminal.conclusion !== child.conclusion
            ) {
              throw new Error(`child ${child.runId} changed before rerun dispatch`);
            }
            return [child.runId, run];
          }),
        ),
      );
      await recheckArtifactProducers(artifactProducers, status, client, true, {
        operationDeadline,
      });
      // Finish admission for the whole batch before any sibling can send a POST.
      await Promise.all(
        requests.map(async ({ child }) => {
          const current = exactTerminalRunState(
            await client.getRun(child.runId, { operationDeadline }),
            child.runId,
          );
          const source = exactTerminalRunState(priorRuns.get(child.runId), child.runId);
          if (JSON.stringify(current) !== JSON.stringify(source)) {
            throw new Error(`child ${child.runId} changed before rerun dispatch`);
          }
        }),
      );
      assertRootRunIdentity(
        await client.getRun(rootRunId, { operationDeadline }),
        parentBinding,
        true,
      );
      const minimumAttempts = new Map(
        requests.map(({ child }) => [child.runId, child.effectiveRunAttempt + 1]),
      );
      remainingOperationTime(operationDeadline);
      const sentRunIds = new Set();
      const mutationResults = await Promise.allSettled(
        requests.map(async ({ child, job }) => {
          remainingOperationTime(operationDeadline);
          sentRunIds.add(child.runId);
          await (job ? client.rerunJob(job.id) : client.rerunFailed(child.runId));
        }),
      );
      if (sentRunIds.size > 0) {
        await reconcileAttemptStarts(
          new Map([...minimumAttempts].filter(([runId]) => sentRunIds.has(runId))),
          priorRuns,
          client,
          mutationResults.filter((_result, index) => sentRunIds.has(requests[index].child.runId)),
          operationDeadline,
          (run) => report(run, true),
        );
      }
      const admissionFailure = mutationResults.find(
        (result, index) =>
          result.status === "rejected" && !sentRunIds.has(requests[index].child.runId),
      );
      if (admissionFailure) {
        throw admissionFailure.reason;
      }
      for (const { child, job } of requests) {
        if (!sentRunIds.has(child.runId)) {
          continue;
        }
        const runAttempt = minimumAttempts.get(child.runId);
        ownedAttempts.set(child.runId, runAttempt);
        if (target) {
          await verifyRerunAttemptJobs(child, runAttempt, client, operationDeadline);
        }
        const record = {
          child: child.key,
          runId: child.runId,
          sourceRunAttempt: child.effectiveRunAttempt,
          runAttempt,
          ...(job
            ? { jobName: job.name, jobId: job.id, acceptedRunAttempt: job.acceptedRunAttempt }
            : {}),
          ...(childRerun
            ? {
                failedJobs: childRerun.failed,
                maxAttempts: target.maxAttempts,
                mode: childRerun.mode,
                runnerBackend: childRerun.runnerBackend,
              }
            : {}),
        };
        reruns.push(record);
        options.audit?.({ parentRunId: String(rootRunId), ...record });
      }
      if (childRerun) {
        return { action: "reran-child", reruns, status };
      }
      continue;
    }
    if (status.active.length === 0 && !pendingArtifactProducers) {
      break;
    }
    await sleep(
      Math.min(
        configuredTimeout("OPENCLAW_FRV_POLL_MS", DEFAULT_POLL_MS),
        remainingOperationTime(operationDeadline),
      ),
    );
    if (pendingArtifactProducers) {
      ({ artifactProducers, pendingArtifactProducers } = await preflightContinuation(
        plan,
        rootRunId,
        client,
        client.repository ?? DEFAULT_REPOSITORY,
        { operationDeadline },
      ));
    }
  }
  if (status.failed.length > 0) {
    throw new Error(
      `failed child reruns did not produce a complete green composite: ${status.failed.map((child) => child.key).join(", ")}`,
    );
  }
  if (options.dryRun) {
    return { action: "would-rerun-parent", status };
  }
  const childEvidenceAdvanced = status.children.some(
    (child) => child.effectiveRunAttempt !== child.plannedRunAttempt,
  );
  const parent = await client.getRun(rootRunId, { operationDeadline });
  if (parent.status !== "completed") {
    await waitForTerminal([rootRunId], client, operationDeadline);
  }
  let completedParent = await client.getRun(rootRunId, { operationDeadline });
  let verificationAttempts;
  let parentSealed = false;
  if (
    completedParent.conclusion === "success" &&
    childEvidenceAdvanced &&
    client.verifySeal !== undefined
  ) {
    verificationAttempts = await freezeVerificationAttempts(
      plan,
      rootRunId,
      status,
      client,
      operationDeadline,
    );
    await recheckArtifactProducers(artifactProducers, status, client, false, { operationDeadline });
    parentSealed = await client.verifySeal(
      rootRunId,
      plan,
      operationDeadline,
      verificationAttempts,
    );
    await recheckArtifactProducers(artifactProducers, status, client, false, { operationDeadline });
    if (!parentSealed) {
      const verifiedParent = exactTerminalRunState(completedParent, rootRunId);
      completedParent = await client.getRun(rootRunId, { operationDeadline });
      const currentParent = exactTerminalRunState(completedParent, rootRunId);
      if (JSON.stringify(currentParent) !== JSON.stringify(verifiedParent)) {
        throw new Error(`verification parent run changed before rerun dispatch: ${rootRunId}`);
      }
    }
  }
  if (!parentSealed && (completedParent.conclusion !== "success" || childEvidenceAdvanced)) {
    const terminalParent = exactTerminalRunState(completedParent, rootRunId);
    const minimumAttempts = new Map([[rootRunId, terminalParent.runAttempt + 1]]);
    await recheckArtifactProducers(artifactProducers, status, client, false, { operationDeadline });
    const currentParent = exactTerminalRunState(
      await client.getRun(rootRunId, { operationDeadline }),
      rootRunId,
    );
    if (JSON.stringify(currentParent) !== JSON.stringify(terminalParent)) {
      throw new Error(`verification parent run changed before rerun dispatch: ${rootRunId}`);
    }
    remainingOperationTime(operationDeadline);
    const mutationResults = await Promise.allSettled([client.rerunParent(rootRunId)]);
    await reconcileAttemptStarts(
      minimumAttempts,
      new Map([[rootRunId, completedParent]]),
      client,
      mutationResults,
      operationDeadline,
      (run) => report(run, true),
    );
    ownedAttempts.set(rootRunId, minimumAttempts.get(rootRunId));
    await waitForTerminal([rootRunId], client, operationDeadline, minimumAttempts);
  }
  if (!parentSealed) {
    await waitForTerminal([...ownedAttempts.keys()], client, operationDeadline, ownedAttempts);
    verificationAttempts = await freezeVerificationAttempts(
      plan,
      rootRunId,
      status,
      client,
      operationDeadline,
    );
    await recheckArtifactProducers(artifactProducers, status, client, false, { operationDeadline });
    await client.verify(rootRunId, plan, operationDeadline, verificationAttempts);
    await recheckArtifactProducers(artifactProducers, status, client, false, { operationDeadline });
  }
  return {
    action: ownedAttempts.has(rootRunId) ? "reran-parent" : "verified-parent",
    finalRunId: rootRunId,
    reruns,
    status,
  };
}

export async function loadPlan(options, loadExecutionPlan = downloadExecutionPlan) {
  const payload = await loadExecutionPlan(options.repository, options.runId);
  if (!payload) {
    throw new Error("run has no authenticated immutable FRV plan");
  }
  const plan = validateReleaseExecutionPlanArtifact(payload, { parentRunId: options.runId });
  if (plan.attemptEvidenceVersion === undefined) {
    throw new Error("run predates attempt-aware immutable plans; run a fresh all-group FRV");
  }
  if (plan.rerunGroup !== "all") {
    throw new Error("FRV continuation requires an all-group root");
  }
  return plan;
}

async function createPublicationReader(repository) {
  const {
    PUBLICATION_LIMITS: limits,
    requirePublication,
    PublicationStatusError,
    parsePublicationRun,
    bindPublicationWorkflow,
    parsePublicationJobs,
    assertPublicationRunUnchanged,
    publicationFailure,
  } = await import("./frv-publication-status.mts");
  const deadline = Date.now() + limits.deadlineMs;
  let requests = 0;
  let totalBytes = 0;
  const runs = new Map();
  const workflows = new Map();
  const artifactLists = new Map();
  const remaining = () => {
    const value = deadline - Date.now();
    requirePublication(value > 0, "deadline");
    return value;
  };
  function bytes(path, maxBytes = limits.jsonBytes) {
    const timeout = Math.min(limits.requestMs, remaining());
    requirePublication(++requests <= limits.requests, "limits");
    let result;
    try {
      result = execPlainGh(
        [
          "api",
          "--hostname",
          "github.com",
          "--method",
          "GET",
          `repos/${repository}/${path}`,
          "-H",
          "Cache-Control: max-age=0",
          "-H",
          "X-GitHub-Api-Version: 2026-03-10",
        ],
        {
          encoding: "buffer",
          stdio: ["ignore", "pipe", "pipe"],
          timeout,
          killSignal: "SIGKILL",
          maxBuffer: maxBytes,
        },
      );
    } catch (error) {
      throw new PublicationStatusError(
        error?.code === "ENOBUFS"
          ? "limits"
          : error?.code === "ETIMEDOUT"
            ? "deadline"
            : "transport",
      );
    }
    requirePublication(
      Buffer.isBuffer(result) && result.length > 0 && result.length <= maxBytes,
      "limits",
    );
    totalBytes += result.length;
    requirePublication(totalBytes <= limits.totalBytes, "limits");
    remaining();
    return result;
  }
  function json(path) {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes(path)));
  }
  function collection(path, key) {
    const entries = [];
    const ids = new Set();
    let total;
    for (let page = 1; page <= limits.pages; page += 1) {
      const value = json(`${path}?per_page=${limits.pageSize}&page=${page}`);
      requirePublication(
        Number.isSafeInteger(value?.total_count) &&
          value.total_count >= 0 &&
          value.total_count <= limits.pages * limits.pageSize,
        "limits",
      );
      total ??= value.total_count;
      requirePublication(
        total === value.total_count &&
          Array.isArray(value[key]) &&
          value[key].length <= limits.pageSize,
        "incomplete",
      );
      for (const entry of value[key]) {
        requirePublication(
          Number.isSafeInteger(entry?.id) && entry.id > 0 && !ids.has(entry.id),
          "incomplete",
        );
        ids.add(entry.id);
        entries.push(entry);
      }
      requirePublication(entries.length <= total, "incomplete");
      if (entries.length === total) {
        return entries;
      }
      requirePublication(value[key].length === limits.pageSize, "incomplete");
    }
    throw new PublicationStatusError("limits");
  }
  async function getRun(runId) {
    const key = String(runId);
    requirePublication(/^[1-9][0-9]*$/u.test(key) && Number.isSafeInteger(Number(key)), "limits");
    if (!runs.has(key)) {
      requirePublication(runs.size < limits.runs, "limits");
      runs.set(key, parsePublicationRun(json(`actions/runs/${key}`), repository, key));
    }
    return runs.get(key);
  }
  async function authenticate(run, path) {
    if (!workflows.has(run.workflow_id)) {
      workflows.set(run.workflow_id, json(`actions/workflows/${run.workflow_id}`));
    }
    bindPublicationWorkflow(run, workflows.get(run.workflow_id), path);
  }
  async function getRunAttempt(runId, attempt) {
    const current = await getRun(runId);
    requirePublication(
      Number.isSafeInteger(attempt) && attempt > 0 && attempt <= current.run_attempt,
    );
    const observed = parsePublicationRun(
      json(`actions/runs/${runId}/attempts/${attempt}`),
      repository,
      String(runId),
    );
    requirePublication(
      observed.run_attempt === attempt &&
        observed.workflow_id === current.workflow_id &&
        observed.path === current.path &&
        observed.head_sha === current.head_sha &&
        observed.head_branch === current.head_branch,
    );
    return observed;
  }
  async function listArtifacts(runId) {
    if (!artifactLists.has(runId)) {
      artifactLists.set(runId, collection(`actions/runs/${runId}/artifacts`, "artifacts"));
    }
    return artifactLists.get(runId);
  }
  function artifactTuple(metadata, run, name) {
    requirePublication(
      metadata &&
        Number.isSafeInteger(metadata.id) &&
        metadata.id > 0 &&
        metadata.name === name &&
        metadata.workflow_run?.id === run.id &&
        metadata.workflow_run?.head_sha === run.head_sha &&
        typeof metadata.digest === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(metadata.digest) &&
        Number.isSafeInteger(metadata.size_in_bytes) &&
        metadata.size_in_bytes > 0 &&
        metadata.size_in_bytes <= limits.archiveBytes &&
        typeof metadata.expired === "boolean" &&
        typeof metadata.expires_at === "string" &&
        Number.isFinite(Date.parse(metadata.expires_at)),
    );
    return JSON.stringify([
      metadata.id,
      metadata.name,
      metadata.digest,
      metadata.size_in_bytes,
      metadata.expired,
      metadata.expires_at,
      metadata.workflow_run.id,
      metadata.workflow_run.head_sha,
    ]);
  }
  async function readArtifact(run, name, filename, maxBytes = limits.expandedBytes) {
    const all = await listArtifacts(String(run.id));
    const matches = all.filter((item) => item.name === name);
    requirePublication(matches.length <= 1);
    if (!matches.length) {
      return { state: "missing" };
    }
    const selected = matches[0];
    const tuple = artifactTuple(selected, run, name);
    if (selected.expired || Date.parse(selected.expires_at) <= Date.now()) {
      return { state: "expired" };
    }
    const fresh = json(`actions/artifacts/${selected.id}`);
    requirePublication(artifactTuple(fresh, run, name) === tuple);
    const archive = bytes(`actions/artifacts/${selected.id}/zip`, limits.archiveBytes);
    requirePublication(
      archive.length === selected.size_in_bytes && sha256Digest(archive) === selected.digest,
    );
    const files = inspectActionsArtifactZipWithPolicy(archive, {
      expectedEntries: [filename],
      maxArchiveBytes: limits.archiveBytes,
      maxExpandedBytes: maxBytes,
      maxEntryBytes: () => maxBytes,
    });
    const entry = files.get(filename);
    requirePublication(entry, "malformed-evidence");
    const after = json(`actions/artifacts/${selected.id}`);
    requirePublication(
      artifactTuple(after, run, name) === tuple && Date.parse(after.expires_at) > Date.now(),
    );
    return {
      state: "available",
      artifactId: selected.id,
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry)),
    };
  }
  return {
    repository,
    getRun,
    getRunAttempt,
    authenticate,
    readArtifact,
    listArtifacts,
    async getAttemptJobs(runId, attempt) {
      return parsePublicationJobs(
        collection(`actions/runs/${runId}/attempts/${attempt}/jobs`, "jobs"),
        String(runId),
        attempt,
      );
    },
    finish() {
      for (const [runId, run] of runs) {
        try {
          assertPublicationRunUnchanged(
            run,
            parsePublicationRun(json(`actions/runs/${runId}`), repository, runId),
          );
        } catch (error) {
          throw new PublicationStatusError(publicationFailure(error), runId);
        }
      }
      remaining();
    },
  };
}

async function inspectPublicationStatus(options) {
  const policy = await import("./frv-publication-status.mts");
  const {
    FRV_WORKFLOW,
    PUBLICATION_WORKFLOW,
    PUBLICATION_LIMITS,
    PUBLICATION_DIAGNOSTIC,
    PUBLICATION_CHILDREN,
    requirePublication,
    newPublicationObservation,
    compactPublicationObservation,
    publicationFailure,
    observePublicationJobs,
    observePublicationDiagnostic,
    parsePublicationDiagnostic,
    boundPublicationManifest,
    joinPublicationValidation,
    observePublicationChild,
    parseWindowsDispatch,
    observeWindowsMarker,
    parseClawHubDispatch,
  } = policy;
  function requireArtifactUploadJob(jobs, jobName, stepName) {
    const matches = jobs.filter((job) => job.name === jobName);
    requirePublication(
      matches.length === 1 &&
        matches[0].steps?.filter(
          (step) =>
            step.name === stepName && step.status === "completed" && step.conclusion === "success",
        ).length === 1,
    );
    return matches[0];
  }
  const { validateParentManifest } = await import("./release-ci-summary.mjs");
  const publication = newPublicationObservation(
    options.repository,
    options.runId,
    options.publicationRunId,
  );
  let status;
  let reader;
  let authenticatingRelationship = true;
  function recordFailure(error) {
    const code = publicationFailure(error);
    const joinedRun = [options.runId, options.publicationRunId].includes(error?.runId);
    publication.collection = { complete: false, error: code };
    if (
      (code === "identity-mismatch" || code === "attempt-changed") &&
      (authenticatingRelationship || joinedRun)
    ) {
      publication.relationship.status = "invalid";
      publication.relationship.reason = code;
    } else if (joinedRun && publication.relationship.status === "verified") {
      publication.relationship.status = "unverified";
      publication.relationship.reason = code;
    }
    process.exitCode = 1;
  }
  try {
    reader = await createPublicationReader(options.repository);
    const root = await reader.getRun(options.runId);
    await reader.authenticate(root, FRV_WORKFLOW);
    const publisher = await reader.getRun(options.publicationRunId);
    await reader.authenticate(publisher, PUBLICATION_WORKFLOW);
    publication.publisher = {
      runId: String(publisher.id),
      runAttempt: publisher.run_attempt,
      workflowSha: publisher.head_sha,
      status: publisher.status,
      conclusion: publisher.conclusion,
    };
    const plan = await loadPlan(options, async () => {
      const artifact = await reader.readArtifact(
        root,
        `full-release-execution-plan-${root.id}`,
        PLAN_FILENAME,
      );
      requirePublication(artifact.state === "available", "incomplete");
      return validateReleaseExecutionPlanArtifact(artifact.value, {
        parentRunId: options.runId,
        repository: options.repository,
        workflowRef: root.head_branch,
        workflowSha: root.head_sha,
        maxParentRunAttempt: root.run_attempt,
      });
    });
    // Authenticate the publication link before unrelated child observations can fail.
    const jobs = await reader.getAttemptJobs(String(publisher.id), publisher.run_attempt);
    observePublicationJobs(publication, publisher, jobs);
    const evidence = await reader.readArtifact(
      publisher,
      `openclaw-release-postpublish-diagnostics-${publisher.id}-${publisher.run_attempt}`,
      PUBLICATION_DIAGNOSTIC,
      PUBLICATION_LIMITS.diagnosticBytes,
    );
    publication.diagnostics.state = evidence.state;
    let diagnostic;
    if (evidence.state === "available") {
      // Failed publishers can upload diagnostics. Their job need not pass; its exact upload must.
      requireArtifactUploadJob(
        jobs,
        "Publish plugins, then OpenClaw",
        "Upload postpublish diagnostics",
      );
      diagnostic = parsePublicationDiagnostic(evidence.value, publisher);
      if (!diagnostic) {
        publication.diagnostics.state = "unsupported";
      } else {
        observePublicationDiagnostic(publication, diagnostic, evidence.artifactId);
        const validation = diagnostic.context.validationEvidence;
        if (
          validation.mode === "full-release-validation" &&
          validation.runId &&
          validation.runAttempt
        ) {
          requirePublication(validation.runId === options.runId);
          const attempt = Number(validation.runAttempt);
          const selected = await reader.getRunAttempt(options.runId, attempt);
          const manifestArtifact = await reader.readArtifact(
            selected,
            `full-release-validation-${selected.id}-${attempt}`,
            "full-release-validation-manifest.json",
          );
          if (manifestArtifact.state === "available") {
            boundPublicationManifest(manifestArtifact.value);
            const manifest = validateParentManifest(manifestArtifact.value, {
              runId: options.runId,
              runAttempt: attempt,
              repository: options.repository,
              workflowRef: root.head_branch,
              workflowSha: root.head_sha,
              candidateBinding: plan.candidate,
            });
            joinPublicationValidation(
              publication,
              diagnostic,
              plan,
              manifest,
              manifestArtifact.value,
            );
          } else {
            publication.relationship.reason = `validation-manifest-${manifestArtifact.state}`;
          }
        } else {
          publication.relationship.reason = "unsupported-or-incomplete-validation-link";
        }
        authenticatingRelationship = false;
        for (const [name, spec] of Object.entries(PUBLICATION_CHILDREN)) {
          const child = diagnostic.children[name];
          if (child.suppliedRunId) {
            const run = await reader.getRun(child.suppliedRunId);
            await reader.authenticate(run, spec.workflow);
            const attempt = child.runAttempt === null ? null : Number(child.runAttempt);
            requirePublication(attempt === null || attempt <= run.run_attempt);
            observePublicationChild(publication, spec.surface, run, attempt);
          }
        }
      }
    } else if (evidence.state === "missing") {
      const artifacts = await reader.listArtifacts(String(publisher.id));
      if (
        artifacts.some((item) => item.name?.startsWith("openclaw-release-postpublish-evidence-"))
      ) {
        publication.diagnostics.state = "legacy-only";
      }
    }
    authenticatingRelationship = false;
    const clawHub = await reader.readArtifact(
      publisher,
      `openclaw-release-children-${publisher.id}-${publisher.run_attempt}`,
      "dispatch.json",
      PUBLICATION_LIMITS.diagnosticBytes,
    );
    if (clawHub.state === "available") {
      const dispatch = parseClawHubDispatch(clawHub.value, publisher, plan.targetSha);
      const supplied = diagnostic?.children.pluginClawHub.suppliedRunId;
      requirePublication(!supplied || supplied === dispatch.normalClawHubRunId);
      publication.dispatches.push({
        scope: "normal-clawhub",
        state: dispatch.normalClawHubRunId ? "acknowledged" : "not-dispatched",
        runId: String(publisher.id),
        runAttempt: publisher.run_attempt,
        artifactId: clawHub.artifactId,
      });
      if (dispatch.normalClawHubRunId) {
        const run = await reader.getRun(dispatch.normalClawHubRunId);
        await reader.authenticate(run, PUBLICATION_CHILDREN.pluginClawHub.workflow);
        const recordedRef = diagnostic?.selection.clawHubWorkflowRef?.replace(
          /^refs\/(?:heads|tags)\//u,
          "",
        );
        requirePublication(
          run.head_sha === publisher.head_sha &&
            (!recordedRef || run.head_branch === recordedRef) &&
            run.run_attempt >= Number(dispatch.normalClawHubRunAttempt),
        );
        observePublicationChild(
          publication,
          "clawHub",
          run,
          Number(dispatch.normalClawHubRunAttempt),
          "dispatch-record",
        );
      }
    }
    const windows = await reader.readArtifact(
      publisher,
      `windows-release-dispatch-${publisher.id}-${publisher.run_attempt}`,
      "windows-dispatch.json",
      PUBLICATION_LIMITS.diagnosticBytes,
    );
    if (windows.state === "available") {
      requireArtifactUploadJob(
        jobs,
        "Dispatch Windows assets after publication",
        "Upload Windows dispatch evidence",
      );
      const dispatch = parseWindowsDispatch(windows.value);
      requirePublication(
        !diagnostic?.context.releaseTag || dispatch.tag === diagnostic.context.releaseTag,
      );
      publication.surfaces.nativeWindows.selection = "selected";
      publication.dispatches.push({
        scope: "windows",
        state: dispatch.state === "dispatched" ? "acknowledged" : "unknown",
        runId: String(publisher.id),
        runAttempt: publisher.run_attempt,
        artifactId: windows.artifactId,
      });
      if (dispatch.state === "dispatched") {
        const run = await reader.getRun(dispatch.childRunId);
        await reader.authenticate(run, ".github/workflows/windows-node-release.yml");
        requirePublication(
          run.head_branch === publisher.head_branch && run.head_sha === publisher.head_sha,
        );
        observePublicationChild(publication, "nativeWindows", run, null, "dispatch-record");
        const terminal = await reader.readArtifact(
          run,
          `windows-release-promotion-${run.id}-${run.run_attempt}`,
          "windows-promotion.json",
          PUBLICATION_LIMITS.diagnosticBytes,
        );
        if (terminal.state === "available") {
          const nativeJobs = await reader.getAttemptJobs(String(run.id), run.run_attempt);
          const nativeOwner = requireArtifactUploadJob(
            nativeJobs,
            "Promote signed Windows installers",
            "Upload Windows promotion evidence",
          );
          observeWindowsMarker(
            publication,
            terminal.value,
            dispatch,
            run,
            terminal.artifactId,
            nativeOwner,
          );
        }
      }
    }
    const children = selectedChildren(plan);
    requirePublication(children.length <= PUBLICATION_LIMITS.runs - 2, "limits");
    // Bound attempt fanout before inspectContinuation allocates its attempt array.
    for (const child of children) {
      if (!hasExactChildRunIdentity(child)) {
        continue;
      }
      const run = await reader.getRun(child.runId);
      await reader.authenticate(run, `.github/workflows/${child.workflow}`);
      requirePublication(
        run.run_attempt >= child.runAttempt &&
          run.run_attempt - child.runAttempt < PUBLICATION_LIMITS.attempts,
        "limits",
      );
    }
    status = await inspectContinuation(plan, reader);
    for (const child of status.children) {
      // Keep publication observations within their bounded validation projection.
      delete child.jobs;
      child.url = child.runId
        ? `https://github.com/${options.repository}/actions/runs/${child.runId}`
        : "";
    }
    requirePublication(!publication.diagnostics.truncated, "incomplete");
    publication.collection.complete = true;
  } catch (error) {
    recordFailure(error);
  }
  // Partial collection still requires final identity checks within the original budget.
  try {
    reader?.finish();
  } catch (error) {
    recordFailure(error);
  }
  const value = { ...status, publication };
  if (Buffer.byteLength(JSON.stringify(value, null, 2)) + 1 > PUBLICATION_LIMITS.outputBytes) {
    process.exitCode = 1;
    const compact = {
      publication: compactPublicationObservation(publication, status !== undefined),
    };
    requirePublication(
      Buffer.byteLength(JSON.stringify(compact, null, 2)) + 1 <= PUBLICATION_LIMITS.outputBytes,
      "limits",
    );
    return compact;
  }
  return value;
}

const DISPATCHED_CHILD_PATTERN =
  /Dispatched ([\w.-]+\.ya?ml): https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/([1-9][0-9]*) \(attempt ([1-9][0-9]*)\)/gu;
const ARTIFACT_DISPATCH_JOBS = [
  ["Prepare release npm artifacts", "artifact:npm"],
  ["Prepare release Docker artifacts", "artifact:docker"],
];
const FAILED_JOB_CONCLUSIONS = new Set([
  "action_required",
  "cancelled",
  "failure",
  "startup_failure",
  "timed_out",
]);

function frvStatePath(repository, runId, suffix) {
  return join(tmpdir(), "openclaw-frv", `${repository.replace("/", "-")}-${runId}-${suffix}`);
}

function readWatchState(path, repository, parentRunId) {
  let saved;
  try {
    saved = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`cannot read watch state ${path}: ${error.message}`, { cause: error });
    }
  }
  if (saved && (saved.repository !== repository || saved.parentRunId !== parentRunId)) {
    throw new Error(`watch state ${path} belongs to another parent run`);
  }
  return {
    children: saved?.children ?? {},
    parentRunId,
    nextCheckAt: saved?.nextCheckAt ?? 0,
    rateLimitFailures: saved?.rateLimitFailures ?? 0,
    failedReadFingerprint: saved?.failedReadFingerprint ?? "",
    reported: new Set(saved?.reported),
    repository,
  };
}

function writeWatchState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...state, reported: [...state.reported] })}\n`);
  renameSync(temporary, path);
}

function formatRunProgress(owner, run, state) {
  return `${owner}${owner === "parent" ? "" : " run"} ${run.id} attempt ${run.run_attempt} ${state ?? (run.status === "completed" ? `completed ${run.conclusion}` : run.status)}`;
}

function formatProgressEvent(command, event) {
  return `[frv ${command}] ${new Date().toISOString().slice(11, 19)}Z ${event.message}${event.url ? ` ${event.url}` : ""}`;
}

function failedJobEvent(owner, job, attempt) {
  if (job.status !== "completed" || !FAILED_JOB_CONCLUSIONS.has(String(job.conclusion))) {
    return undefined;
  }
  const labels = Array.isArray(job.labels) && job.labels.length > 0 ? job.labels.join(",") : "none";
  const runner = job.runner_name ? ` / ${job.runner_name}` : "";
  return [
    `job:${job.id}`,
    `${owner} job "${job.name}" ${job.conclusion} (attempt ${job.run_attempt ?? attempt}; runner ${labels}${runner})`,
    job.html_url,
  ];
}

async function mapBounded(values, limit, operation) {
  const results = [];
  for (let index = 0; index < values.length; index += limit) {
    results.push(...(await Promise.all(values.slice(index, index + limit).map(operation))));
  }
  return results;
}

async function pollRelease(state, client, pending, readOptions) {
  const events = [];
  const failedReads = [];
  const report = (id, message, url) => {
    if (!state.reported.has(id)) {
      state.reported.add(id);
      events.push({ message, ...(url ? { url: String(url) } : {}) });
    }
  };
  // Transient GitHub failures, including HTML 5xx bodies, never become job results.
  const read = async (label, operation) => {
    if (state.nextCheckAt > Date.now()) {
      return undefined;
    }
    try {
      return await operation();
    } catch (error) {
      const retryAt = releaseGhRateLimitRetryAt(error, Date.now(), state.rateLimitFailures);
      if (retryAt !== undefined) {
        state.nextCheckAt = Math.max(state.nextCheckAt, retryAt);
        state.rateLimitFailures += 1;
      }
      const text = String(error?.stderr ?? error?.message ?? error);
      if (classifyReleaseGhTransportError(error) === "hard" && !/HTTP 404\b/u.test(text)) {
        throw error;
      }
      failedReads.push(label);
      return undefined;
    }
  };
  const parentRunId = state.parentRunId;
  const parent = await read("parent run", () => client.getRun(parentRunId, readOptions));
  if (!parent) {
    return { complete: false, events, failedReads };
  }
  const parentDone = parent.status === "completed";
  report(
    `run:${parentRunId}:${parent.run_attempt}:${parentDone ? "completed" : "active"}`,
    formatRunProgress("parent", parent),
    parent.html_url,
  );
  const dispatchKeys = new Map([
    ...releaseChildSpecs().map((spec) => [spec.parentJobName, spec.key]),
    ...ARTIFACT_DISPATCH_JOBS,
  ]);
  const parentJobs = await read("parent jobs", () =>
    client.getParentJobs(parentRunId, readOptions),
  );
  // A relay snapshot can lag the parent run; completion waits for settled jobs and every dispatch log.
  let dispatchPending =
    !parentJobs?.some((job) => Number(job.run_attempt) === Number(parent.run_attempt)) ||
    parentJobs.some((job) => job.status !== "completed");
  for (const job of parentJobs ?? []) {
    const failure = failedJobEvent("parent", job, parent.run_attempt);
    if (failure) {
      report(...failure);
    }
    const key = dispatchKeys.get(job.name);
    if (!key || job.conclusion === "skipped" || state.reported.has(`log:${job.id}`)) {
      continue;
    }
    if (job.status !== "completed") {
      dispatchPending = true;
      continue;
    }
    const log = await read(`${job.name} log`, () => client.getJobLog(job.id, readOptions));
    if (log === undefined) {
      continue;
    }
    for (const [, workflow, repository, runId, attempt] of stripVTControlCharacters(
      String(log),
    ).matchAll(DISPATCHED_CHILD_PATTERN)) {
      if (repository === state.repository && !state.children[runId]) {
        state.children[runId] = { key, workflow };
        report(
          `dispatched:${runId}`,
          `${key} dispatched ${workflow} run ${runId} (attempt ${attempt})`,
          `https://github.com/${repository}/actions/runs/${runId}`,
        );
      }
    }
    state.reported.add(`log:${job.id}`);
  }
  // Bounded fanout keeps shared GitHub quota for the rest of the release.
  const childStates = await mapBounded(
    Object.entries(state.children),
    4,
    async ([runId, child]) => {
      const run = await read(`${child.key} run`, () => client.getRun(runId, readOptions));
      if (!run) {
        return false;
      }
      const current = Number(run.run_attempt);
      const done = run.status === "completed";
      report(
        `run:${runId}:${current}:${done ? "completed" : "active"}`,
        formatRunProgress(child.key, run),
        run.html_url,
      );
      // Earlier attempts are final; scan each once so a late start still reports them.
      let scansComplete = true;
      for (let attempt = 1; attempt <= current; attempt += 1) {
        const scanned = `jobs:${runId}:${attempt}`;
        if (state.reported.has(scanned)) {
          continue;
        }
        const jobs = await read(`${child.key} attempt ${attempt} jobs`, () =>
          client.getAttemptJobs(runId, attempt, readOptions),
        );
        if (!jobs) {
          return false;
        }
        // A relay snapshot can lag the run; only an all-terminal job list is final.
        const final =
          (attempt < current || done) &&
          jobs.length > 0 &&
          jobs.every((job) => job.status === "completed");
        scansComplete &&= final;
        for (const job of jobs) {
          const failure = failedJobEvent(child.key, job, attempt);
          if (failure) {
            report(...failure);
          }
        }
        const duplicates = duplicateJobNames(jobs);
        // Attempts briefly list overlapping jobs while GitHub materializes them.
        if (duplicates.length > 0 && (final || pending.has(scanned))) {
          report(
            `duplicates:${runId}:${attempt}`,
            `${child.key} run ${runId} attempt ${attempt} holds duplicate jobs: ${duplicates.join(", ")}`,
            run.html_url,
          );
        }
        pending[duplicates.length > 0 ? "add" : "delete"](scanned);
        if (final) {
          state.reported.add(scanned);
        }
      }
      return done && scansComplete;
    },
  );
  const complete =
    parentDone && !dispatchPending && childStates.every(Boolean) && failedReads.length === 0;
  return { complete, events, failedReads };
}

/** Report parent and child transitions once, resuming from a small local state file. */
export async function watchRelease(parentRunId, client, options = {}) {
  const repository = client.repository ?? DEFAULT_REPOSITORY;
  const operationDeadline = options.operationDeadline ?? createOperationDeadline();
  const statePath = options.statePath ?? frvStatePath(repository, parentRunId, "watch.json");
  const intervalMs =
    options.intervalMs ?? configuredTimeout("OPENCLAW_FRV_WATCH_POLL_MS", DEFAULT_WATCH_POLL_MS);
  const emit = options.emit ?? ((event) => console.log(event.message));
  const state = readWatchState(statePath, repository, String(parentRunId));
  const pending = new Set();
  while (true) {
    const { complete, events, failedReads } =
      state.nextCheckAt > Date.now()
        ? { complete: false, events: [], failedReads: [] }
        : await pollRelease(state, client, pending, { operationDeadline });
    if (failedReads.length > 0) {
      const fingerprint = `${failedReads.join(", ")}:${state.nextCheckAt}`;
      if (state.failedReadFingerprint !== fingerprint) {
        events.push({
          message:
            state.nextCheckAt > Date.now()
              ? `GitHub rate limited (${failedReads.join(", ")}); next check at ${new Date(state.nextCheckAt).toISOString()}`
              : `GitHub reads failed (${failedReads.join(", ")}); retrying next poll`,
        });
        state.failedReadFingerprint = fingerprint;
      }
    } else if (state.nextCheckAt <= Date.now()) {
      state.nextCheckAt = 0;
      state.rateLimitFailures = 0;
      state.failedReadFingerprint = "";
    }
    writeWatchState(statePath, state);
    for (const event of events) {
      emit(event);
    }
    if (complete) {
      emit({ message: `parent ${parentRunId} and every dispatched child are terminal` });
      return { complete, statePath };
    }
    const remaining = operationDeadline - Date.now();
    if (options.once || remaining < 1) {
      return { complete, statePath };
    }
    await sleep(Math.min(Math.max(intervalMs, state.nextCheckAt - Date.now()), remaining));
  }
}

function appendRerunAudit(repository, record) {
  const path = frvStatePath(repository, record.parentRunId, "reruns.jsonl");
  const line = JSON.stringify({ at: new Date().toISOString(), repository, ...record });
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${line}\n`);
  console.error(`[frv] audit ${path}: ${line}`);
}

function print(value, json) {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (value.qualification) {
    console.log(
      `qualification: ${value.qualification.state}; evidence: ${value.qualification.evidence}`,
    );
    console.log(
      `drain: ${value.drain.status} ${value.drain.conclusion}; active children: ${value.drain.activeRunIds.join(", ") || "none"}`,
    );
    console.log(
      `workloads: ${value.failed.length} failed, ${value.active.length} active, ${value.missing.length} missing`,
    );
    console.log(`candidate: ${value.candidate.sha}; tip: ${value.candidate.state}`);
    if (value.decision) {
      console.log(formatReleaseStateOutcome(value.decision));
    }
    for (const error of value.observationErrors) {
      console.log(`observation: ${error}`);
    }
    console.log(`next: ${value.nextCommand}`);
  }
  for (const child of value.status?.children ?? value.children ?? []) {
    console.log(
      `${child.key}: ${child.status}${child.conclusion && child.conclusion !== "success" ? ` (${child.conclusion})` : ""} attempt=${child.effectiveRunAttempt} planned=${child.plannedRunAttempt} run=${child.runId}`,
    );
  }
  for (const run of value.rerun ?? []) {
    console.log(`${run.name} ${run.id} ${run.headBranch} ${run.url}`);
  }
  for (const run of value.skipped ?? []) {
    console.log(
      `skipped (rerun not attempted): ${run.name} ${run.id} ${run.headBranch} ${run.url}`,
    );
  }
  if (value.action === "restored" && value.skipped?.length) {
    console.log(
      "Inspect the skipped runs and their latest PR checks, then preview with pnpm frv prioritize --restore <record> --dry-run using the same record and same --repo. Restore without --dry-run only if those checks still need recovery.",
    );
  }
  for (const failure of value.failures ?? []) {
    console.log(`failure: ${failure}`);
  }
  if (value.childRerun) {
    console.log(
      `plan: ${value.childRerun.mode} ${value.childRerun.producer ?? value.childRerun.failed.join(", ")}`,
    );
  }
  if (value.action) {
    console.log(`action: ${value.action}`);
  }
  if (value.action === "reran-child") {
    console.log(
      "next: follow it with pnpm frv watch --run <parent>; reseal with pnpm frv continue --failed --run <parent> once children are green",
    );
  }
  if (value.finalRunId) {
    console.log(`final run: https://github.com/openclaw/openclaw/actions/runs/${value.finalRunId}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.publicationRunId) {
    const value = await inspectPublicationStatus(options);
    print(value, options.json);
    if (!options.json) {
      const { formatPublicationObservation } = await import("./frv-publication-status.mts");
      console.log(formatPublicationObservation(value.publication));
    }
    return;
  }
  if (options.command === "watch") {
    await watchRelease(options.runId, createClient(options.repository, { cachedReads: true }), {
      emit: (event) =>
        console.log(
          options.json
            ? JSON.stringify({ at: new Date().toISOString(), ...event })
            : formatProgressEvent("watch", event),
        ),
      intervalMs: options.intervalMs,
      once: options.once,
      statePath: options.statePath,
    });
    return;
  }
  const client = createClient(options.repository);
  if (options.command === "prioritize") {
    print(
      await restoreReleasePriority(options.restore, client, { dryRun: options.dryRun }),
      options.json,
    );
    return;
  }
  if (options.command === "verify") {
    const plan = await loadPlan(options);
    const evidence = await client.verify(options.runId, plan, createOperationDeadline());
    console.log(evidence);
    await releaseSealedPriority(client, options.runId);
    return;
  }
  const plan = await loadPlan(options);
  if (options.command === "status") {
    print(await inspectQualificationStatus(plan, options.runId, client), options.json);
    return;
  }
  const result = await continueFailed(plan, options.runId, client, {
    audit: (record) => appendRerunAudit(options.repository, record),
    child: options.child,
    dryRun: options.dryRun,
    job: options.job,
    maxAttempts: options.maxAttempts,
  });
  print(result, options.json);
  if (!options.dryRun && options.command === "continue") {
    await releaseSealedPriority(client, options.runId);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(
      process.argv.includes("--publication-run")
        ? "[frv] publication observation: usage"
        : `[frv] ${error instanceof Error ? error.message : String(error)}`,
    );
    console.error("[frv] FAILED (exit 1)");
    process.exitCode = 1;
  }
}

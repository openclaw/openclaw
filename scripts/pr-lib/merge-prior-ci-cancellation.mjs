import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { execPrGhJson } from "./github.mjs";

const oid = /^[0-9a-f]{40}$/;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const badSteps = new Set(["failure", "timed_out", "action_required", "startup_failure"]);
const monitorNames = new Set([
  "Cancel remaining PR work after a failure",
  "Classify PR failures and cancel eligible same-repository work",
]);

function readWorkflow({ evidence, git, requireEvidence }) {
  const path = ".github/workflows/ci.yml";
  const baseline = git(["rev-parse", `${evidence.priorHead}:${path}`])
    .toString("utf8")
    .trim();
  const workflowBlob = git(["rev-parse", `${evidence.testedMerge}:${path}`])
    .toString("utf8")
    .trim();
  requireEvidence(
    oid.test(workflowBlob) && workflowBlob === baseline,
    "cancellation workflow changed in the tested PR merge",
  );
  return {
    workflowBlob,
    workflow: parse(git(["show", `${evidence.testedMerge}:${path}`]).toString("utf8")),
  };
}

function qualifyBoundaryDeadline(context, job, seconds, cancelledAnnotationCount) {
  const { requireEvidence } = context;
  const { workflow, workflowBlob } = readWorkflow(context);
  const workflowJob = "check-additional-shard";
  const owner = workflow?.jobs?.[workflowJob];
  const sourceSteps = owner?.steps?.filter((step) => step.name === "Run additional check shard");
  const source = sourceSteps?.[0];
  requireEvidence(
    owner?.name === "${{ matrix.check_name || 'check-additional-shard' }}" &&
      Array.isArray(owner.needs) &&
      owner.needs.includes("preflight") &&
      owner.strategy?.matrix ===
        "${{ fromJSON(needs.preflight.outputs.check_additional_matrix) }}" &&
      owner.strategy["fail-fast"] === false &&
      owner["timeout-minutes"] === 20 &&
      seconds === 1200 &&
      [undefined, false].includes(owner["continue-on-error"]) &&
      sourceSteps?.length === 1 &&
      source.shell === "bash" &&
      source.uses === undefined &&
      source.env?.ADDITIONAL_CHECK_GROUP === "${{ matrix.group }}" &&
      [undefined, false].includes(source["continue-on-error"]) &&
      typeof source.run === "string" &&
      digest(source.run) === "fbc8e4f959c865558e529e9b4cad09493d132f7b0f851c7a77eb27a84d984ca6",
    "boundary deadline requires the unchanged historical package-boundary workflow owner",
  );
  const steps = job.steps;
  const jobStart = Date.parse(job.started_at);
  const jobEnd = Date.parse(job.completed_at);
  const shards = steps.filter((step) => step.name === source.name);
  const shard = shards[0];
  requireEvidence(
    context.jobs.filter((candidate) => candidate.name === job.name).length === 1 &&
      shards.length === 1 &&
      shard.number === owner.steps.indexOf(source) + 2 &&
      ["success", "cancelled"].includes(shard.conclusion) &&
      cancelledAnnotationCount === (shard.conclusion === "cancelled" ? 1 : 0) &&
      steps.every((step, index) => {
        const start = Date.parse(step.started_at);
        const end = Date.parse(step.completed_at);
        return (
          positiveInteger(step.number) &&
          (index === 0 || step.number > steps[index - 1].number) &&
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          jobStart <= start &&
          start <= end &&
          end <= jobEnd &&
          (index === 0 || Date.parse(steps[index - 1].completed_at) <= start) &&
          (step === shard || ["success", "skipped"].includes(step.conclusion))
        );
      }) &&
      Date.parse(shard.completed_at) - jobStart >= seconds * 1000 &&
      steps.at(-1)?.name === "Complete job" &&
      steps.at(-1).conclusion === "success",
    "boundary deadline has incomplete or contradictory step evidence",
  );
  return { workflowBlob, workflowJob, step: shard, steps };
}

/** A cancelled job can retain a failed execution step or an exhausted deadline. */
export function qualifyPriorCiCancelledRoots(context) {
  const { evidence, run, jobs, gate, requireEvidence } = context;
  const readJson = (endpoint, paginate = false) =>
    execPrGhJson([
      "api",
      "--hostname",
      "github.com",
      endpoint,
      "-H",
      "Cache-Control: max-age=0",
      ...(paginate ? ["--paginate", "--slurp"] : []),
    ]);
  const roots = new Map();
  for (const job of jobs) {
    if (
      job === gate ||
      job.conclusion !== "cancelled" ||
      !Array.isArray(evidence.failures) ||
      !evidence.failures.some((entry) => entry.jobId === job.id)
    ) {
      continue;
    }
    const prefix = `https://api.github.com/repos/${evidence.repository}/check-runs/`;
    const checkRunId = Number(
      job.check_run_url?.startsWith(prefix) && job.check_run_url.slice(prefix.length),
    );
    requireEvidence(
      positiveInteger(checkRunId),
      "deadline root requires its canonical check-run identity",
    );
    const endpoint = `repos/${evidence.repository}/check-runs/${checkRunId}`;
    const check = readJson(endpoint);
    requireEvidence(
      check.id === checkRunId &&
        check.name === job.name &&
        check.head_sha === evidence.head &&
        check.check_suite?.id === run.check_suite_id &&
        check.app?.id === 15368 &&
        check.app.slug === "github-actions" &&
        check.status === "completed" &&
        check.conclusion === "cancelled" &&
        check.started_at === job.started_at &&
        check.completed_at === job.completed_at,
      "cancelled deadline/failed-step root requires a matching live GitHub Actions check-run",
    );
    const attribution = evidence.failures.find((value) => value.jobId === job.id);
    if (attribution.failedStep !== undefined) {
      roots.set(job.id, {
        failedStep: qualifyFailedStep(context, attribution, job, checkRunId),
      });
      continue;
    }
    const pages = readJson(`${endpoint}/annotations?per_page=100`, true);
    requireEvidence(
      Array.isArray(pages) && pages.every(Array.isArray),
      "deadline annotations are incomplete",
    );
    const annotations = pages.flat();
    const timeout = annotations.filter(
      (entry) =>
        entry.annotation_level === "failure" &&
        entry.title === "" &&
        entry.path === ".github" &&
        entry.start_line === 1 &&
        /^The job has exceeded the maximum execution time of (?:\d+h)?\d+m\d+s$/u.test(
          entry.message,
        ),
    );
    const cancelled = annotations.filter(
      (entry) =>
        entry.annotation_level === "failure" &&
        entry.title === "" &&
        entry.path === ".github" &&
        positiveInteger(entry.start_line) &&
        entry.message === "The operation was canceled.",
    );
    const boundary = job.name === "check-additional-extension-package-boundary";
    requireEvidence(
      check.output?.annotations_count === annotations.length &&
        timeout.length === 1 &&
        cancelled.length <= 1 &&
        annotations.length === 1 + cancelled.length &&
        (boundary || (cancelled.length === 1 && /\d+h\d+m\d+s$/u.test(timeout[0].message))),
      "deadline root requires complete matching GitHub Actions timeout annotations",
    );
    const parts = /(?:(\d+)h)?(\d+)m(\d+)s$/u.exec(timeout[0].message);
    const seconds = Number(parts[1] ?? 0) * 3600 + Number(parts[2]) * 60 + Number(parts[3]);
    requireEvidence(
      positiveInteger(seconds) &&
        Number(parts[2]) < 60 &&
        Number(parts[3]) < 60 &&
        Date.parse(job.completed_at) - Date.parse(job.started_at) >= seconds * 1000 &&
        Array.isArray(job.steps) &&
        job.steps.every(
          (step) =>
            step.status === "completed" &&
            ["success", "skipped", "cancelled"].includes(step.conclusion),
        ) &&
        (boundary ||
          (job.steps.filter((step) => step.conclusion === "cancelled").length === 1 &&
            job.steps.some(
              (step) => step.name === "Run Node test shard" && step.conclusion === "cancelled",
            ))),
      "deadline root has contradictory duration or additional failed steps",
    );
    const binding = boundary
      ? qualifyBoundaryDeadline(context, job, seconds, cancelled.length)
      : { workflowBlob: readWorkflow(context).workflowBlob };
    roots.set(job.id, {
      deadline: { checkRunId, conclusion: job.conclusion, seconds, ...binding, annotations },
    });
  }
  return roots;
}

function qualifyFailedStep(context, entry, job, checkRunId) {
  const { requireEvidence } = context;
  const binding = entry.failedStep;
  const productionTypes = binding?.workflowJob === "check-shard";
  const realGateway = binding?.workflowJob === "checks-ui-e2e-real-gateway";
  const workflowJob = realGateway
    ? "checks-ui-e2e-real-gateway"
    : productionTypes
      ? "check-shard"
      : "checks-node-core-test-nondist-shard";
  const stepName = realGateway
    ? "Test Control UI suites with a real Gateway"
    : productionTypes
      ? "Run check shard"
      : "Run Node test shard";
  const steps = job.steps;
  requireEvidence(
    binding?.workflowJob === workflowJob &&
      positiveInteger(binding.number) &&
      Array.isArray(steps) &&
      steps.length > 0 &&
      steps.every(
        (step) =>
          positiveInteger(step.number) &&
          step.status === "completed" &&
          ["success", "skipped", "failure"].includes(step.conclusion),
      ) &&
      new Set(steps.map((step) => step.number)).size === steps.length &&
      steps.filter((step) => step.conclusion === "failure").length === 1 &&
      steps.filter((step) => step.name === stepName).length === 1 &&
      steps.at(-1)?.name === "Complete job" &&
      steps.at(-1).conclusion === "success",
    `cancelled root requires complete steps with only one failed ${stepName}`,
  );
  const step = steps.find((value) => value.number === binding.number);
  const times = [job.started_at, step?.started_at, step?.completed_at, job.completed_at].map(
    Date.parse,
  );
  requireEvidence(
    step?.name === stepName &&
      step.conclusion === "failure" &&
      times.every(Number.isFinite) &&
      times.every((time, index) => index === 0 || time >= times[index - 1]),
    "cancelled root has mismatched step identity or timestamps",
  );
  const { workflow, workflowBlob } = readWorkflow(context);
  const owner = workflow?.jobs?.[workflowJob];
  const sourceSteps = owner?.steps?.filter((value) => value.name === step.name);
  const source = sourceSteps?.[0];
  const build =
    realGateway &&
    owner?.steps?.find(
      (value) => value.name === "Build runtime and Control UI artifacts for real-Gateway tests",
    );
  requireEvidence(
    owner?.name ===
      (realGateway
        ? "${{ matrix.shard_count == 1 && 'checks-ui-e2e-real-gateway' || format('checks-ui-e2e-real-gateway ({0}/{1})', matrix.shard, matrix.shard_count) }}"
        : productionTypes
          ? "${{ matrix.check_name || 'check-shard' }}"
          : "${{ matrix.check_name || 'checks-node-core-test-nondist-shard' }}") &&
      Array.isArray(owner.needs) &&
      owner.needs.includes("preflight") &&
      owner.strategy?.matrix ===
        (realGateway
          ? "${{ fromJson(needs.preflight.outputs.ui_real_gateway_matrix) }}"
          : productionTypes
            ? "${{ fromJSON((needs.preflight.outputs.run_check_plan == 'true' && needs.check-plan.outputs.check_matrix || needs.preflight.outputs.check_matrix)) }}"
            : "${{ fromJson(needs.preflight.outputs.checks_node_core_nondist_matrix) }}") &&
      (!productionTypes ||
        (owner.needs.includes("check-plan") &&
          owner.strategy["fail-fast"] === false &&
          source?.env?.TASK === "${{ matrix.task }}" &&
          source.if ===
            "matrix.task != 'lint' || !(needs.preflight.outputs.run_check_plan == 'true' && needs.check-plan.outputs.central_lint_selection_json || needs.preflight.outputs.central_lint_selection_json)")) &&
      (!realGateway ||
        (owner.strategy["fail-fast"] === false &&
          owner.strategy["max-parallel"] === 2 &&
          source?.if === "matrix.run_tests" &&
          source.env?.FROZEN_TARGET === "${{ needs.preflight.outputs.frozen_target }}" &&
          source.env?.OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64 ===
            "${{ matrix.test_groups_gzip_base64 }}" &&
          build?.run === "pnpm build" &&
          build.env?.OPENCLAW_BUILD_PRIVATE_QA === "1" &&
          [undefined, false].includes(build["continue-on-error"]) &&
          steps.some((value) => value.name === build.name && value.conclusion === "success"))) &&
      [undefined, false].includes(owner["continue-on-error"]) &&
      sourceSteps?.length === 1 &&
      source.shell === (realGateway ? undefined : "bash") &&
      source.uses === undefined &&
      [undefined, false].includes(source["continue-on-error"]) &&
      typeof source.run === "string" &&
      // Recognize audited entrypoints, not arbitrary workflow commands.
      digest(source.run) ===
        (realGateway
          ? "29353781c0f1a64854dd3183b13949d5b4581b091ca95ad5a99e0bb9f10279e2"
          : productionTypes
            ? "bcaa8c10327d52a2964e7b14a085554c34e969eb4c23621198c57800f3a7cc2d"
            : "43a70550e9537ea675a8052ebd4821200d24ffa6a48ccd3b44c047f667490691"),
    `cancelled root requires the unchanged canonical ${realGateway ? "real-Gateway UI" : productionTypes ? "production-type" : "Node shard"} workflow owner`,
  );
  if (productionTypes || realGateway) {
    const jobStart = Date.parse(job.started_at);
    const jobEnd = Date.parse(job.completed_at);
    const runnerPrelude = realGateway && steps[1]?.name === "Set up runner";
    const offset = runnerPrelude ? 3 : 2;
    requireEvidence(
      (realGateway
        ? /^checks-ui-e2e-real-gateway(?: \([12]\/2\))?$/u.test(job.name)
        : job.name === "check-prod-types") &&
        context.jobs.filter((candidate) => candidate.name === job.name).length === 1 &&
        step.number === owner.steps.indexOf(source) + offset &&
        steps[0].number === 1 &&
        steps[0].name === "Set up job" &&
        (!realGateway ||
          (steps[0].conclusion === "success" &&
            steps.length === owner.steps.length + (runnerPrelude ? 5 : 3) &&
            (!runnerPrelude ||
              (steps[1].number === 2 &&
                steps[1].conclusion === "success" &&
                steps.at(-2).name === "Complete runner" &&
                steps.at(-2).conclusion === "success")) &&
            steps.at(runnerPrelude ? -3 : -2).name === "Post Setup Node environment" &&
            steps.at(runnerPrelude ? -3 : -2).conclusion === "success")) &&
        owner.steps.every((expected, index) =>
          steps.some((actual) => actual.number === index + offset && actual.name === expected.name),
        ) &&
        steps.every((current, index) => {
          const start = Date.parse(current.started_at);
          const end = Date.parse(current.completed_at);
          return (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            jobStart <= start &&
            start <= end &&
            end <= jobEnd &&
            (index === 0 ||
              (current.number > steps[index - 1].number &&
                Date.parse(steps[index - 1].completed_at) <= start))
          );
        }),
      "cancelled root requires complete ordered source-matching steps",
    );
  }
  // Matrix membership and causal baseline qualification remain inspected evidence.
  return {
    ...binding,
    checkRunId,
    conclusion: job.conclusion,
    workflowBlob,
    step,
    ...(productionTypes || realGateway ? { steps } : {}),
  };
}

function verifyMatrixCancellation(context, cancellation, members) {
  const { run, requireEvidence } = context;
  const workflowJob = "checks-node-core-test-nondist-shard";
  requireEvidence(
    run.event === "pull_request" &&
      cancellation.workflowJob === workflowJob &&
      cancellation.jobId === undefined &&
      cancellation.step === undefined,
    "matrix cancellation requires the existing PR Node matrix owner",
  );
  const { workflow, workflowBlob } = readWorkflow(context);
  const owner = workflow?.jobs?.[workflowJob];
  const failFast = owner?.strategy?.["fail-fast"];
  const repository = run.repository?.full_name;
  const attemptAwareFailFast =
    failFast ===
      "${{ github.event_name == 'pull_request' && (github.run_attempt != 1 || github.repository != 'openclaw/openclaw') }}" &&
    positiveInteger(run.run_attempt) &&
    typeof repository === "string" &&
    /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u.test(repository) &&
    // Actions compares strings without case; github.repository is the workflow owner, not the fork.
    (run.run_attempt > 1 || repository.toLowerCase() !== "openclaw/openclaw");
  requireEvidence(
    owner?.name === "${{ matrix.check_name || 'checks-node-core-test-nondist-shard' }}" &&
      Array.isArray(owner.needs) &&
      owner.needs.includes("preflight") &&
      owner.strategy?.matrix ===
        "${{ fromJson(needs.preflight.outputs.checks_node_core_nondist_matrix) }}" &&
      ([true, "${{ github.event_name == 'pull_request' }}"].includes(failFast) ||
        attemptAwareFailFast) &&
      [undefined, false].includes(owner["continue-on-error"]),
    "the tested workflow must enable the existing PR matrix fail-fast contract",
  );
  // GitHub jobs omit their matrix owner. Membership and cause remain inspected
  // operator attestations; exact names/IDs bind them without inferring from prefixes.
  requireEvidence(
    Array.isArray(cancellation.members) &&
      cancellation.members.length === members.length &&
      new Set(cancellation.members.map((member) => member?.jobId)).size === members.length &&
      cancellation.members.every(
        (member) =>
          positiveInteger(member?.jobId) &&
          nonempty(member.name) &&
          members.some((job) => job.id === member.jobId && job.name === member.name),
      ),
    "matrix membership bindings must name every admitted root and cancelled job exactly",
  );
  return { ...cancellation, workflowBlob };
}

const producerName = "Run built artifact checks";
const uploadName = "Upload Discord component attachment proof";
const uploadAction = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
// Reviewed historical producer: both outputs are created inside this step.
// This recognizes its skipped-output contract, not arbitrary Bash or authority.
const producerRunSha256 = "8bce28636b217a2c8766bf5f62fa3b63b502f1e75c4d02225e440034f9a3f458";
const selection = "${{ needs.preflight.outputs.run_discord_component_proof }}";
const outputPaths = [
  "${{ runner.temp }}/discord-component-attachments.json",
  "${{ runner.temp }}/discord-component-attachments.log",
];

function readJobLog(artifact, job, requireEvidence) {
  const bytes = readFileSync(artifact.path);
  requireEvidence(digest(bytes) === artifact.sha256, "secondary failure log changed");
  const records = [];
  for (const line of bytes.toString("utf8").replaceAll("\uFEFF", "").split(/\r?\n/u)) {
    const match = /^([^\t]+)\t([^\t]+)\t(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (.*)$/u.exec(line);
    if (match) {
      requireEvidence(
        match[1] === job.name && Number.isFinite(Date.parse(match[3])),
        "secondary failure log belongs to another job or has invalid timestamps",
      );
      records.push({ step: match[2], time: Date.parse(match[3]), text: match[4] });
    } else if (records.length) {
      const current = records[records.length - 1];
      const prefix = `${job.name}\t${current.step}\t`;
      requireEvidence(
        !line.includes("\t") || line.startsWith(prefix),
        "secondary log continuation belongs to another job or step",
      );
      current.text += `\n${line.startsWith(prefix) ? line.slice(prefix.length) : line}`;
    } else {
      requireEvidence(line.trim() === "", "secondary failure needs the inspected full job log");
    }
  }
  for (const record of records) {
    record.text = record.text.trimEnd();
  }
  return records;
}

function verifySkippedArtifactUpload(context, cancellation, monitor, cancelled) {
  const { evidence, run, jobs, references, requireEvidence } = context;
  const entries = cancellation.secondaryFailures;
  requireEvidence(
    run.event === "pull_request" && Array.isArray(entries) && entries.length === 1,
    "secondary cancellation only supports one inspected skipped-producer artifact failure",
  );
  const entry = entries[0];
  const job = cancelled.find((value) => value.id === entry?.jobId);
  requireEvidence(
    entry?.kind === "missing-artifact-after-skipped-producer" &&
      references(entry) &&
      entry.evidence.includes(entry.log) &&
      positiveInteger(entry.step) &&
      positiveInteger(entry.producerStep) &&
      job?.name === "build-artifacts" &&
      jobs.filter((value) => value.name === job.name).length === 1 &&
      Array.isArray(job.steps) &&
      job.steps.every((step) => positiveInteger(step.number)) &&
      new Set(job.steps.map((step) => step.number)).size === job.steps.length,
    "secondary failure must bind the unique cancelled build-artifacts producer and upload",
  );
  const findStep = (name) => {
    const matches = job.steps.filter((step) => step.name === name);
    requireEvidence(matches.length === 1, `secondary failure needs one ${name} step`);
    return matches[0];
  };
  const producer = findStep(producerName);
  const upload = findStep(uploadName);
  const build = findStep("Build dist");
  const monitorSteps = monitor.steps.filter((step) => step.number === cancellation.step);
  requireEvidence(
    monitorSteps.length === 1 &&
      producer.number === entry.producerStep &&
      producer.status === "completed" &&
      producer.conclusion === "skipped" &&
      upload.number === entry.step &&
      upload.status === "completed" &&
      upload.conclusion === "failure" &&
      build.status === "completed" &&
      build.conclusion === "cancelled" &&
      build.number < producer.number &&
      producer.number < upload.number,
    "secondary upload failure requires a cancelled build and a uniquely skipped producer",
  );
  const times = [
    monitorSteps[0].completed_at,
    build.started_at,
    build.completed_at,
    producer.started_at,
    producer.completed_at,
    upload.started_at,
    upload.completed_at,
  ].map(Date.parse);
  const [monitorEnd, buildStart, buildEnd, producerStart, producerEnd, uploadStart, uploadEnd] =
    times;
  requireEvidence(
    times.every(Number.isFinite) &&
      buildStart <= monitorEnd &&
      monitorEnd <= buildEnd &&
      buildEnd <= producerStart &&
      producerStart === producerEnd &&
      producerEnd <= uploadStart &&
      uploadStart <= uploadEnd,
    "secondary upload failure has missing or contradictory cancellation timestamps",
  );
  const { workflow, workflowBlob } = readWorkflow(context);
  const sourceJob = workflow?.jobs?.["build-artifacts"];
  requireEvidence(
    Array.isArray(sourceJob?.steps) && [undefined, "build-artifacts"].includes(sourceJob.name),
    "secondary upload workflow has no unique build-artifacts owner",
  );
  const sourceProducers = sourceJob.steps.filter((step) => step.name === producerName);
  const sourceUploads = sourceJob.steps.filter((step) => step.name === uploadName);
  const sourceProducer = sourceProducers[0];
  const sourceUpload = sourceUploads[0];
  requireEvidence(
    sourceProducers.length === 1 &&
      sourceUploads.length === 1 &&
      [undefined, false].includes(sourceJob["continue-on-error"]) &&
      sourceJob.steps.indexOf(sourceProducer) < sourceJob.steps.indexOf(sourceUpload) &&
      sourceProducer.uses === undefined &&
      sourceProducer.shell === "bash" &&
      sourceProducer.env?.RUN_DISCORD_COMPONENT_PROOF === selection &&
      typeof sourceProducer.run === "string" &&
      digest(sourceProducer.run) === producerRunSha256 &&
      [undefined, false].includes(sourceProducer["continue-on-error"]) &&
      sourceUpload.uses === uploadAction &&
      sourceUpload.run === undefined &&
      sourceUpload.if ===
        "always() && needs.preflight.outputs.run_discord_component_proof == 'true'" &&
      [undefined, false].includes(sourceUpload["continue-on-error"]) &&
      sourceUpload.with?.name === "discord-component-attachments" &&
      sourceUpload.with?.["if-no-files-found"] === "error" &&
      sourceUpload.with?.["retention-days"] === 7 &&
      JSON.stringify(Object.keys(sourceUpload.with).toSorted()) ===
        JSON.stringify(["if-no-files-found", "name", "path", "retention-days"]) &&
      typeof sourceUpload.with?.path === "string" &&
      sourceUpload.with.path.trim() === outputPaths.join("\n"),
    "secondary upload does not match the audited historical producer/action/output contract",
  );
  const artifact = evidence.artifacts.find((value) => value.name === entry.log);
  const records = readJobLog(artifact, job, requireEvidence);
  requireEvidence(
    records.at(-1)?.step === "Complete job",
    "secondary failure requires the complete job log through cleanup",
  );
  for (const key of ["CHECKOUT_SHA", "WORKFLOW_SHA"]) {
    requireEvidence(
      records.some(
        (record) =>
          record.step === "Checkout" && record.text.trim() === `${key}: ${evidence.testedMerge}`,
      ),
      "secondary failure log does not identify the tested checkout/workflow",
    );
  }
  const errors = records.filter((record) => record.text.includes("##[error]"));
  const missing = errors[1]?.text.match(
    /^##\[error\]No files were found with the provided path: (\/[^\n]+)\/discord-component-attachments\.json\n\1\/discord-component-attachments\.log\. No artifacts will be uploaded\.$/u,
  );
  requireEvidence(
    errors.length === 2 &&
      errors[0].step === build.name &&
      errors[0].text === "##[error]The operation was canceled." &&
      errors[0].time >= monitorEnd &&
      errors[0].time >= buildStart &&
      errors[0].time < buildEnd + 1000 &&
      errors[1].step === upload.name &&
      missing &&
      errors[0].time <= errors[1].time &&
      errors[1].time >= uploadStart &&
      errors[1].time < uploadEnd + 1000 &&
      !records.some((record) => record.step === producerName) &&
      records.some(
        (record) =>
          record.step === uploadName &&
          record.time >= uploadStart &&
          record.time <= errors[1].time &&
          record.text === `##[group]Run ${uploadAction}`,
      ),
    "secondary failure log must show only cancellation and both missing outputs, not another failure",
  );
  // API step times have whole-second precision; log lines retain fractions.
  return {
    step: upload,
    job,
    proof: { ...entry, workflowBlob, producerRunSha256, logSha256: artifact.sha256 },
  };
}

export function verifyPriorCiCancellation(context) {
  const { evidence, jobs, failed, gate, causedByRoots, requireEvidence } = context;
  const cancelled = jobs.filter(
    (job) => job.conclusion === "cancelled" && job !== gate && !failed.includes(job),
  );
  const cancellation = evidence.cancellation;
  const result = { cancelledJobIds: cancelled.map((job) => job.id).toSorted((a, b) => a - b) };
  if (cancelled.length === 0) {
    requireEvidence(cancellation === undefined, "cancellation attribution has no matching jobs");
    return result;
  }
  const matrix = cancellation?.kind === "matrix-fail-fast";
  // Other independently attributed failures still belong to the aggregate, not this matrix.
  const matrixCauses =
    matrix && Array.isArray(cancellation.causedBy)
      ? failed.filter((job) => cancellation.causedBy.includes(job.id))
      : [];
  const qualifiedCauses = matrix
    ? context.references(cancellation) &&
      matrixCauses.length > 0 &&
      cancellation.causedBy.length === matrixCauses.length &&
      new Set(cancellation.causedBy).size === matrixCauses.length
    : causedByRoots(cancellation);
  requireEvidence(
    qualifiedCauses &&
      Array.isArray(cancellation.jobIds) &&
      JSON.stringify(cancellation.jobIds.toSorted((a, b) => a - b)) ===
        JSON.stringify(result.cancelledJobIds),
    "all cancelled jobs require explicit inspected fail-fast provenance; cancellation is not passing coverage",
  );
  requireEvidence(
    cancelled.every((job) => Array.isArray(job.steps)),
    "cancelled jobs must not hide failed steps or omit step evidence",
  );
  let secondary;
  if (cancellation.kind === "matrix-fail-fast") {
    requireEvidence(
      cancellation.secondaryFailures === undefined,
      "secondary artifact failures require the successful owned cancellation monitor",
    );
    result.cancellation = verifyMatrixCancellation(context, cancellation, [
      ...matrixCauses,
      ...cancelled,
    ]);
  } else {
    const owner = jobs.find((job) => job.id === cancellation.jobId);
    requireEvidence(
      [undefined, "pr-fail-fast"].includes(cancellation.kind) &&
        owner?.name === "pr-fail-fast" &&
        owner.conclusion === "success" &&
        positiveInteger(cancellation.step) &&
        Array.isArray(owner.steps) &&
        owner.steps.some(
          (step) =>
            step.number === cancellation.step &&
            monitorNames.has(step.name) &&
            step.status === "completed" &&
            step.conclusion === "success",
        ),
      "all cancelled jobs require explicit inspected fail-fast provenance; cancellation is not passing coverage",
    );
    if (cancellation.secondaryFailures !== undefined) {
      secondary = verifySkippedArtifactUpload(context, cancellation, owner, cancelled);
      result.cancellation = { ...cancellation, secondaryFailures: [secondary.proof] };
    }
  }
  requireEvidence(
    cancelled.every((job) =>
      job.steps.every(
        (step) =>
          !badSteps.has(step.conclusion) || (job === secondary?.job && step === secondary.step),
      ),
    ),
    "cancelled jobs must not hide failed steps or omit step evidence",
  );
  return result;
}

#!/usr/bin/env node
// Linux/GNU time baseline of the real manifest -> optional check-plan CLI flow.
// Usage and accounting boundaries: scripts/bench-ci-planner.md.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, release, tmpdir, totalmem } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseBenchmarkInteger,
  parseBenchmarkOptions,
  runBenchmarkEntrypoint,
  summarizeBenchmarkTimings,
  writeBenchmarkJson,
} from "./lib/benchmark-harness.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";

const workloadRevision = "79f5aeb133830a1db60b55cff3cf7a617086aa07";
const outputLimit = 16 * 1024 * 1024;
const diagnosticLimit = 4096;
const stageTimeoutMs = 240_000;
const harnessRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cases = [
  { name: "main", event: "push", paths: null },
  { name: "cron", event: "pull_request", paths: ["src/cron/schedule.ts"] },
  { name: "discord", event: "pull_request", paths: ["extensions/discord/src/channel.ts"] },
] as const;
type PlannerCase = (typeof cases)[number];

function digest(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function command(bin: string, args: string[], cwd: string) {
  return execFileSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: outputLimit,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function identity(root: string) {
  return {
    revision: command("git", ["rev-parse", "HEAD"], root),
    tree: command("git", ["rev-parse", "HEAD^{tree}"], root),
    dirty: command("git", ["status", "--porcelain=v1", "--untracked-files=normal"], root) !== "",
    packageManager: JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"))
      .packageManager as string,
    lockSha256: digest(readFileSync(path.join(root, "pnpm-lock.yaml"))),
    timingsSha256: digest(readFileSync(path.join(root, "config/ci-test-timings.json"))),
  };
}

export function parsePlannerOutputs(text: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const line of text.split("\n")) {
    if (!line) {
      continue;
    }
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (separator < 1 || !/^[a-z][a-z0-9_]*$/u.test(key) || Object.hasOwn(result, key)) {
      throw new Error("Planner output contains a malformed or duplicate key");
    }
    result[key] = line.slice(separator + 1);
  }
  return result;
}

export function parsePlannerResources(text: string) {
  // GNU time's locale-independent %U/%S/%e are seconds, %M is KiB.
  const match = /^planner-resources\t(\d+\.\d+)\t(\d+\.\d+)\t(\d+\.\d+)\t(\d+)\n?$/u.exec(text);
  if (!match) {
    throw new Error("Missing or invalid GNU time resource record");
  }
  const values = match.slice(1).map(Number);
  if (
    values.some((value) => !Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
  ) {
    throw new Error("Invalid GNU time resource value");
  }
  return {
    userCpuSeconds: values[0]!,
    systemCpuSeconds: values[1]!,
    commandWallSeconds: values[2]!,
    maximumResidentKiB: values[3]!,
  };
}

function plannerEnvironment(workload: string, selection: PlannerCase): NodeJS.ProcessEnv {
  // Deliberately do not inherit credentials, planner switches, caches, or Node preloads.
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    CI: "true",
    LANG: "C",
    LC_ALL: "C",
    NODE_OPTIONS: "--max-old-space-size=8192",
    OPENCLAW_CI_EVENT_NAME: selection.event,
    OPENCLAW_CI_REPOSITORY: "openclaw/openclaw",
    OPENCLAW_CI_HEAD_REPOSITORY: "openclaw/openclaw",
    OPENCLAW_CI_PR_AUTHOR_TYPE: "User",
    OPENCLAW_CI_CHANGED_PATHS_JSON: JSON.stringify(selection.paths),
    OPENCLAW_CI_CHECKOUT_REVISION: command("git", ["rev-parse", "HEAD"], workload),
    OPENCLAW_CI_WORKFLOW_REVISION: command("git", ["rev-parse", "HEAD"], workload),
    OPENCLAW_CI_RUN_NODE: "true",
    OPENCLAW_CI_RUNNER_PROFILE: "github",
    OPENCLAW_CI_NODE_RUNNER_BACKEND: "github",
    OPENCLAW_CI_RUNNER_BACKEND: "github",
    OPENCLAW_CI_RELEASE_GATE: "false",
    OPENCLAW_CI_RELEASE_SCOPE: "full",
    OPENCLAW_CI_VALIDATION_TIER: "full",
    GITHUB_REF: selection.event === "push" ? "refs/heads/main" : "refs/pull/1/merge",
  };
}

export async function measurePlannerStage(options: {
  cwd: string;
  script: string;
  args?: string[];
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
}) {
  const scratch = mkdtempSync(path.join(tmpdir(), "ci-planner-stage-"));
  const outputFile = path.join(scratch, "outputs");
  const timeFile = path.join(scratch, "time");
  const overflow = new AbortController();
  let observedBytes = 0;
  const hashes = [createHash("sha256"), createHash("sha256")];
  const diagnostics = ["", ""];
  let timedOut = false;
  let interrupted: string | null = null;
  let exitCode: number | null = null;
  let failure: unknown;
  let output = "";
  let resources: ReturnType<typeof parsePlannerResources> | null = null;
  const startedAt = new Date().toISOString();
  const started = performance.now();
  writeFileSync(outputFile, "");
  // The planner writes its protocol to a file, so bound that transport as well as pipes.
  const monitor = setInterval(() => {
    if (statSync(outputFile).size > outputLimit) {
      overflow.abort();
    }
  }, 100);
  try {
    exitCode = await runManagedCommand({
      bin: "/usr/bin/time",
      args: [
        "-q",
        "-f",
        "planner-resources\t%U\t%S\t%e\t%M",
        "-o",
        timeFile,
        process.execPath,
        options.script,
        ...(options.args ?? []),
      ],
      cwd: options.cwd,
      env: { ...options.env, GITHUB_OUTPUT: outputFile },
      stdio: ["ignore", "pipe", "pipe"],
      timeoutMs: options.timeoutMs ?? stageTimeoutMs,
      timeoutKillGraceMs: 30_000,
      signalKillGraceMs: 30_000,
      abortKillGraceMs: 30_000,
      cleanupDrainTimeoutMs: 10_000,
      requireProcessTreeExit: true,
      signal: AbortSignal.any([overflow.signal, ...(options.signal ? [options.signal] : [])]),
      onTimeout() {
        timedOut = true;
      },
      onSignal(signal) {
        interrupted = signal;
      },
      onReady(child) {
        for (const [index, pipe] of [child.stdout!, child.stderr!].entries()) {
          pipe.on("data", (chunk: Buffer) => {
            observedBytes += chunk.byteLength;
            hashes[index]!.update(chunk);
            if (diagnostics[index]!.length < diagnosticLimit) {
              diagnostics[index] += chunk
                .toString("utf8")
                .slice(0, diagnosticLimit - diagnostics[index]!.length);
            }
            if (observedBytes > outputLimit) {
              overflow.abort();
            }
          });
        }
      },
    });
    if (statSync(outputFile).size > outputLimit) {
      throw new Error("Planner output exceeded 16 MiB");
    }
    output = readFileSync(outputFile, "utf8");
    resources = parsePlannerResources(readFileSync(timeFile, "utf8"));
  } catch (error) {
    failure = error;
  } finally {
    clearInterval(monitor);
  }
  // Cancellation still leaves useful protocol/resource bytes. Read only bounded files;
  // their presence never repairs a failed status or certifies descendant cleanup.
  if (failure) {
    try {
      if (statSync(outputFile).size <= outputLimit) {
        output = readFileSync(outputFile, "utf8");
      }
      if (existsSync(timeFile) && statSync(timeFile).size <= diagnosticLimit) {
        resources = parsePlannerResources(readFileSync(timeFile, "utf8"));
      }
    } catch {
      // Keep the original failure and explicit unavailable metrics.
    }
  }
  const wallMs = performance.now() - started;
  const cancelled = interrupted !== null || options.signal?.aborted === true;
  // GNU time is an intermediary: a killed planner can lose custody of detached compiler
  // groups. Never upgrade an interrupted/failed stage to verified descendant cleanup.
  const cleanupValid =
    !failure && exitCode === 0 && !cancelled && !timedOut && !overflow.signal.aborted;
  const scratchRemoved = !hasUnjoinedWork(failure);
  if (scratchRemoved) {
    rmSync(scratch, { recursive: true, force: true });
  }
  const redact = (text: string) =>
    text
      .replaceAll(options.cwd, "<workload>")
      .replaceAll(harnessRoot, "<harness>")
      .replaceAll(scratch, "<stage>");
  return {
    status: timedOut ? "timeout" : cancelled ? "cancelled" : cleanupValid ? "success" : "failure",
    command: ["/usr/bin/time", "node", options.script, ...(options.args ?? [])].map((value) =>
      redact(value),
    ),
    startedAt,
    endedAt: new Date().toISOString(),
    wallMs,
    exitCode,
    signal: interrupted,
    cleanupValid,
    scratchRemoved,
    resourceAccountingValid: cleanupValid && resources !== null,
    resources,
    unavailableReason: cleanupValid
      ? null
      : "failed, interrupted, or unverified descendant cleanup",
    error: failure
      ? redact(
          failure instanceof Error
            ? `${failure.name}: ${failure.message}`
            : typeof failure === "string"
              ? failure
              : "Process failed with a non-Error value",
        )
      : overflow.signal.aborted
        ? "output limit exceeded"
        : null,
    stdoutSha256: hashes[0]!.digest("hex"),
    stderrSha256: hashes[1]!.digest("hex"),
    observedPipeBytes: observedBytes,
    diagnostics: diagnostics.map(redact),
    outputSha256: digest(output),
    outputBytes: Buffer.byteLength(output),
    output,
  };
}

async function runPlannerFlow(workload: string, name: string, signal?: AbortSignal) {
  const selection = cases.find((entry) => entry.name === name);
  if (!selection) {
    throw new Error(`Unknown planner case: ${name}`);
  }
  for (const file of selection.paths ?? []) {
    if (!existsSync(path.join(workload, file))) {
      throw new Error(`Workload does not contain ${file}`);
    }
  }
  const env = plannerEnvironment(workload, selection);
  const started = performance.now();
  const manifest = await measurePlannerStage({
    cwd: workload,
    script: "scripts/ci-build-manifest.mjs",
    env,
    signal,
  });
  let check: Awaited<ReturnType<typeof measurePlannerStage>> | null = null;
  let checkOmissionReason: string | null = "manifest failed";
  let manifestOutputs: Record<string, string> | null = null;
  let checkOutputs: Record<string, string> | null = null;
  let error: string | null = null;
  try {
    if (manifest.status !== "success") {
      throw new Error("Manifest process did not succeed");
    }
    manifestOutputs = parsePlannerOutputs(manifest.output);
    for (const key of ["check_matrix", "checks_node_core_nondist_matrix"]) {
      if (!Array.isArray(JSON.parse(manifestOutputs[key] ?? "null")?.include)) {
        throw new Error(`Manifest did not emit ${key}`);
      }
    }
    if (!["true", "false"].includes(manifestOutputs.run_check_plan ?? "")) {
      throw new Error("Manifest did not declare run_check_plan");
    }
    if (manifestOutputs.run_check_plan === "true") {
      const input = manifestOutputs.check_plan_input_json;
      if (!input || !JSON.parse(input) || typeof JSON.parse(input) !== "object") {
        throw new Error("Manifest did not provide a check-plan input object");
      }
      checkOmissionReason = null;
      check = await measurePlannerStage({
        cwd: workload,
        script: "scripts/ci-check-plan.mts",
        env: { ...env, OPENCLAW_CI_CHECK_PLAN_INPUT_JSON: input },
        signal,
      });
      if (check.status !== "success") {
        throw new Error("Check-plan process did not succeed");
      }
      checkOutputs = parsePlannerOutputs(check.output);
      for (const key of [
        "check_matrix",
        "core_type_matrix",
        "lint_core_matrix",
        "lint_extension_matrix",
      ]) {
        if (!Array.isArray(JSON.parse(checkOutputs[key] ?? "null")?.include)) {
          throw new Error(`Check plan did not emit ${key}`);
        }
      }
    } else {
      checkOmissionReason = "actual manifest run_check_plan=false";
    }
  } catch (caught) {
    error = String(caught);
  }
  const stages = [manifest, ...(check ? [check] : [])];
  const valid =
    error === null && stages.every((stage) => stage.cleanupValid && stage.resourceAccountingValid);
  const stripOutput = ({ output: _output, ...stage }: typeof manifest) => stage;
  return {
    case: selection.name,
    changedPaths: selection.paths,
    profile: Object.fromEntries(
      Object.entries(env).filter(([key]) => !["PATH", "HOME", "TMPDIR"].includes(key)),
    ),
    status: valid
      ? "success"
      : (stages.find((stage) => stage.status !== "success")?.status ?? "failure"),
    valid,
    error,
    wallMs: performance.now() - started,
    manifest: stripOutput(manifest),
    check: check ? stripOutput(check) : null,
    checkOmissionReason,
    checkInputSha256: check ? digest(manifestOutputs!.check_plan_input_json!) : null,
    // Exact planner outputs retain selected files/groups/jobs, not a second planner's estimates.
    manifestOutputs,
    checkOutputs,
    userCpuSeconds: valid
      ? stages.reduce((sum, stage) => sum + stage.resources!.userCpuSeconds, 0)
      : null,
    systemCpuSeconds: valid
      ? stages.reduce((sum, stage) => sum + stage.resources!.systemCpuSeconds, 0)
      : null,
  };
}

export function writePlannerReport(
  report: {
    valid: boolean;
    summaries: unknown[];
    flows: Array<{ manifestOutputs: unknown; checkOutputs: unknown; [key: string]: unknown }>;
    [key: string]: unknown;
  },
  output: string,
) {
  if (Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`) > outputLimit) {
    writeBenchmarkJson(
      {
        ...report,
        valid: false,
        reportError:
          "Aggregate planner payload exceeds 16 MiB; complete plan outputs omitted, measurement invalid",
        summaries: [],
        flows: report.flows.map(
          ({ manifestOutputs: _manifest, checkOutputs: _check, ...flow }) => ({
            ...flow,
            valid: false,
            planOutputsOmitted: true,
          }),
        ),
      },
      output,
    );
    return false;
  }
  writeBenchmarkJson(report, output);
  return report.valid;
}

async function main() {
  const options = parseBenchmarkOptions(
    process.argv.slice(2),
    {
      help: false,
      json: true,
      output: "ci-planner-benchmark.json",
      workload: "",
      expectedRevision: workloadRevision,
      repetitions: 5,
      selection: "all",
    },
    {
      "--workload": (parsedOptions, value) => {
        parsedOptions.workload = value;
      },
      "--workload-sha": (parsedOptions, value) => {
        parsedOptions.expectedRevision = value;
      },
      "--output": (parsedOptions, value) => {
        parsedOptions.output = value;
      },
      "--repetitions": (parsedOptions, value) => {
        parsedOptions.repetitions = parseBenchmarkInteger(value, "--repetitions", 1, 5);
      },
      "--case": (parsedOptions, value) => {
        parsedOptions.selection = value;
      },
    },
  );
  if (options.help) {
    console.log(
      "node scripts/bench-ci-planner.mts --workload <clean-installed-checkout> --output <report.json>\nDefaults: frozen workload 79f5aeb, all three cases, five serial repetitions. See scripts/bench-ci-planner.md.",
    );
    return;
  }
  if (process.platform !== "linux" || process.version !== "v24.22.1") {
    throw new Error("This measurement requires Linux and Node v24.22.1");
  }
  if (!options.workload || !/^[0-9a-f]{40}$/u.test(options.expectedRevision)) {
    throw new Error("Provide --workload and an exact 40-character workload SHA");
  }
  const workload = path.resolve(options.workload);
  const source = identity(workload);
  const harness = identity(harnessRoot);
  if (source.revision !== options.expectedRevision || source.dirty || harness.dirty) {
    throw new Error("Harness and workload must be clean, and workload must match the selected SHA");
  }
  const pnpm = command("pnpm", ["--version"], workload);
  if (
    pnpm !== "12.15.0" ||
    source.packageManager !== harness.packageManager ||
    !source.packageManager.startsWith("pnpm@12.15.0+sha512.")
  ) {
    throw new Error(
      "The separately installed checkouts must retain the pinned pnpm 12.15.0 integrity identity",
    );
  }
  const timeVersion = command("/usr/bin/time", ["--version"], workload);
  if (!timeVersion.includes("GNU Time")) {
    throw new Error("GNU time is required; BSD time is not compatible");
  }
  const selected = cases.filter(
    (entry) => options.selection === "all" || entry.name === options.selection,
  );
  if (selected.length === 0) {
    throw new Error("--case must be all, main, cron, or discord");
  }
  const cancellation = new AbortController();
  let collectionDeadlineReached = false;
  const deadline = setTimeout(() => {
    collectionDeadlineReached = true;
    cancellation.abort();
  }, 20 * 60_000);
  const onSignal = () => cancellation.abort();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  const flows: Array<
    Awaited<ReturnType<typeof runPlannerFlow>> & {
      repetition: number;
      ordinal: number;
      planParity: "reference" | "matched" | "mismatch" | "unavailable";
    }
  > = [];
  const planReferences = new Map<string, string>();
  try {
    for (let repetition = 1; repetition <= options.repetitions; repetition++) {
      for (const selection of selected) {
        console.error(`[bench-ci-planner] start ${selection.name} repetition ${repetition}`);
        const result = await runPlannerFlow(workload, selection.name, cancellation.signal);
        const planHash = digest(JSON.stringify([result.manifestOutputs, result.checkOutputs]));
        const reference = planReferences.get(selection.name);
        const planParity = !result.valid
          ? "unavailable"
          : reference === undefined
            ? "reference"
            : reference === planHash
              ? "matched"
              : "mismatch";
        if (planParity === "mismatch") {
          result.valid = false;
          result.error = "Planner output differs from the first repetition of this case";
          result.status = "failure";
        }
        if (result.valid) {
          planReferences.set(selection.name, reference ?? planHash);
        }
        flows.push({ ...result, repetition, ordinal: flows.length + 1, planParity });
        // Never start more work while a failed stage may still own descendants.
        if (!result.valid || cancellation.signal.aborted) {
          break;
        }
      }
      if (flows.at(-1)?.valid !== true || cancellation.signal.aborted) {
        break;
      }
    }
  } finally {
    clearTimeout(deadline);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
  let sourceUnchanged = false;
  let sourceVerificationError: string | null = null;
  try {
    sourceUnchanged =
      JSON.stringify(identity(workload)) === JSON.stringify(source) &&
      JSON.stringify(identity(harnessRoot)) === JSON.stringify(harness);
  } catch {
    sourceVerificationError = "Could not recheck harness/workload source after measurement";
  }
  const expectedFlows = selected.length * options.repetitions;
  const valid =
    sourceUnchanged && flows.length === expectedFlows && flows.every((flow) => flow.valid);
  const report = {
    schema: "openclaw-ci-planner-benchmark.v1",
    valid,
    expectedFlows,
    observedFlows: flows.length,
    omittedFlows: expectedFlows - flows.length,
    collectionDeadlineReached,
    omissionReason:
      flows.length < expectedFlows
        ? "stopped after invalid or cancelled flow; remaining work was not executed"
        : null,
    sourceUnchanged,
    sourceVerificationError,
    identity: {
      harness,
      workload: source,
      node: process.version,
      pnpm,
      timeVersion,
      timeSha256: digest(readFileSync("/usr/bin/time")),
      runner: {
        platform: process.platform,
        arch: process.arch,
        kernelRelease: release(),
        logicalProcessors: availableParallelism(),
        cpuModel: cpus()[0]?.model ?? null,
        totalMemoryBytes: totalmem(),
        imageOS: process.env.ImageOS ?? null,
        imageVersion: process.env.ImageVersion ?? null,
      },
      workflowRevision: process.env.GITHUB_WORKFLOW_SHA ?? null,
      workflowCheckout: process.env.GITHUB_SHA ?? null,
      runId: process.env.GITHUB_RUN_ID ?? null,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
      installProof: process.env.PLANNER_BENCHMARK_INSTALL_PROOF ?? null,
      buildProof:
        "No application build required by planner CLI; native compiler inventory queries are included",
      harnessSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
    },
    measurement: {
      order: "repetition-major: main, cron, discord; serial fresh CLI processes",
      wall: "monotonic milliseconds around complete stage plus owned cleanup; flow includes protocol handoff",
      cpu: "GNU time user/system seconds for command and waited descendants; 0.01-second printed resolution",
      memory:
        "GNU time maximum resident KiB; largest per-process lifetime high-water, not aggregate tree RSS",
      caches: "No explicit planner cache restore/save; fresh processes do not imply cold OS caches",
      comparison: "Baseline only; no speedup, queue-share, I17 cache, or Rust benefit inference",
      cleanup:
        "Interruption through GNU time cannot certify detached descendants; invalid stages stop collection",
    },
    summaries: selected.map(({ name }) => {
      const validFlows = flows.filter((flow) => flow.case === name && flow.valid);
      return {
        case: name,
        validSamples: validFlows.length,
        wallMs: validFlows.length
          ? summarizeBenchmarkTimings(validFlows.map((flow) => flow.wallMs))
          : null,
      };
    }),
    flows,
  };
  const reportedValid = writePlannerReport(report, options.output);
  if (!reportedValid) {
    process.exitCode = 1;
  }
  console.log(
    JSON.stringify({
      valid: reportedValid,
      expectedFlows,
      observedFlows: flows.length,
      summaries: report.summaries,
    }),
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  await runBenchmarkEntrypoint("bench-ci-planner", main);
}

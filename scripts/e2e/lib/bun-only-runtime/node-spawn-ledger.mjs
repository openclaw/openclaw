import { findLauncherTokens } from "./sentinel.mjs";

/** @typedef {{name: string, sentinelStart?: number, sentinelEnd?: number, startMs?: number, endMs?: number, status?: string, exitCode?: number, stdout?: string, stderr?: string, output?: string, durationMs?: number}} Step */
/** @typedef {{pid: number, cmdline: string}} Ancestor */
/** @typedef {{index?: number, name: string, exe?: string, pid: number, ppid: number, cwd: string, argv: string[], ancestors: Ancestor[]}} SentinelRecord */
/** @typedef {{pid: number, ppid: number, childPid?: number | null, errorCode?: string | null, ts: number | string, cmd: string[], cwd?: string, stack: string[]}} TraceRecord */
/** @typedef {{step: string | null, argv: string[], pid: number, ppid: number, cwd?: string, ancestors: Ancestor[], stack: string[], sentinel?: SentinelRecord, trace?: TraceRecord, shellPath?: string}} Attempt */
/** @typedef {{id: string, feature: string, origin: string, owner: string, callSite: string, step: string | null, match?: {stack?: string[], argv?: string[]}, evidence: string | string[], failure?: string, notExercisedReason?: string}} Blocker */

const basename = (value) => value.split("/").at(-1);
const timestamp = (value) => (typeof value === "number" ? value : Date.parse(value));
const isShell = (trace) => ["sh", "bash", "dash"].includes(basename(trace.cmd[0] ?? ""));

/**
 * Each window extends from its start to the next step's start, including background
 * work after the step ends. Sentinels use decoded-record indexes; traces use epoch
 * milliseconds. Keep unmatched direct traces: ENOENT never reaches a sentinel. In a shell,
 * a bare launcher always reaches the PATH sentinel when it runs; a path-qualified launcher
 * without a sentinel at that exact path is reported, which errs toward reporting probes.
 * @param {{sentinelRecords: SentinelRecord[], traceRecords: TraceRecord[], steps: Step[]}} input
 * @returns {Attempt[]}
 */
export function attributeSpawns({ sentinelRecords, traceRecords, steps }) {
  const used = new Set();
  const attempts = sentinelRecords.map((sentinel, recordIndex) => {
    const index = sentinel.index ?? recordIndex;
    const step = steps.findLast((candidate) => index >= candidate.sentinelStart);
    // childPid identifies the exact process, so correlation ignores step windows:
    // a background spawn can straddle a step boundary between trace and sentinel.
    const directIndex = traceRecords.findIndex(
      (trace, candidateIndex) =>
        !used.has(candidateIndex) &&
        !isShell(trace) &&
        trace.childPid != null &&
        trace.childPid === sentinel.pid &&
        basename(trace.cmd[0] ?? "") === sentinel.name &&
        trace.cmd.length === sentinel.argv.length + 1 &&
        sentinel.argv.every((arg, argIndex) => arg === trace.cmd[argIndex + 1]),
    );
    if (directIndex !== -1) {
      used.add(directIndex);
    }
    // A shell trace only lends its caller's stack to the sentinels it started; `sh -c`
    // may exec its last command in place, so the sentinel can be the shell itself.
    const trace =
      directIndex !== -1
        ? traceRecords[directIndex]
        : traceRecords.find(
            (candidate) =>
              isShell(candidate) &&
              candidate.childPid != null &&
              (sentinel.pid === candidate.childPid ||
                sentinel.ancestors.some((ancestor) => ancestor.pid === candidate.childPid)),
          );
    return {
      step: step?.name ?? null,
      argv: [sentinel.name, ...sentinel.argv],
      pid: sentinel.pid,
      ppid: sentinel.ppid,
      cwd: sentinel.cwd,
      ancestors: sentinel.ancestors,
      stack: trace?.stack ?? [],
      sentinel,
      ...(trace ? { trace } : {}),
    };
  });
  traceRecords.forEach((trace, index) => {
    if (used.has(index)) {
      return;
    }
    const step = steps.findLast((candidate) => timestamp(trace.ts) >= candidate.startMs);
    if (isShell(trace)) {
      const paths = new Set(
        trace.cmd
          .slice(1)
          .flatMap((arg) => findLauncherTokens(arg))
          .filter((token) => token.includes("/")),
      );
      for (const shellPath of paths) {
        const ran = sentinelRecords.some(
          (sentinel) =>
            sentinel.exe === shellPath &&
            trace.childPid != null &&
            (sentinel.pid === trace.childPid ||
              sentinel.ancestors.some((ancestor) => ancestor.pid === trace.childPid)),
        );
        if (!ran) {
          attempts.push({
            step: step?.name ?? null,
            argv: [shellPath],
            pid: trace.pid,
            ppid: trace.ppid,
            cwd: trace.cwd,
            ancestors: [],
            stack: trace.stack,
            trace,
            shellPath,
          });
        }
      }
      return;
    }
    attempts.push({
      step: step?.name ?? null,
      argv: trace.cmd,
      pid: trace.pid,
      ppid: trace.ppid,
      cwd: trace.cwd,
      ancestors: [],
      stack: trace.stack,
      trace,
    });
  });
  return attempts;
}

/** @param {Attempt} attempt @param {Blocker} blocker @param {Step[]} steps */
function matches(attempt, blocker, steps) {
  const blockerIndex = steps.findIndex((step) => step.name === blocker.step);
  return (
    blockerIndex !== -1 &&
    steps.findIndex((step) => step.name === attempt.step) >= blockerIndex &&
    blocker.match !== undefined &&
    (blocker.match.stack ?? []).every((name) =>
      attempt.stack.some((frame) => frame.includes(name)),
    ) &&
    (blocker.match.argv ?? []).every((arg) => attempt.argv.some((value) => value.includes(arg)))
  );
}

/** @param {{attempts: Attempt[], steps: Step[], blockers: Blocker[]}} input */
export function classifyNodeSpawns({ attempts, steps, blockers }) {
  const classified = blockers.map((blocker) => {
    const step = steps.find((candidate) => candidate.name === blocker.step);
    const exercised = step && !["skipped", "not-run"].includes(step.status);
    const evidence = Array.isArray(blocker.evidence) ? blocker.evidence : [blocker.evidence];
    // Failure-only entries must never excuse spawns, even if they declare a matcher.
    const matchedAttempts = evidence.includes("spawn")
      ? attempts.filter((attempt) => matches(attempt, blocker, steps))
      : [];
    const output = [step?.stdout, step?.stderr, step?.output].filter(Boolean).join("\n");
    const reproducedBy = [];
    if (evidence.includes("spawn") && matchedAttempts.length > 0) {
      reproducedBy.push("spawn");
    }
    if (evidence.includes("failure") && blocker.failure && output.includes(blocker.failure)) {
      reproducedBy.push("failure");
    }
    return {
      ...blocker,
      status: !exercised ? "not-exercised" : reproducedBy.length > 0 ? "reproduced" : "stale",
      matchedAttempts,
      reproducedBy,
      ...(!exercised && !blocker.notExercisedReason
        ? { notExercisedReason: "Step did not run." }
        : {}),
    };
  });
  const unexpectedAttempts = attempts.filter(
    (attempt) =>
      !classified.some(
        (blocker) => blocker.status === "reproduced" && blocker.matchedAttempts.includes(attempt),
      ),
  );
  const staleBlockers = classified.filter((blocker) => blocker.status === "stale");
  const failedSteps = steps.filter(
    (step) =>
      step.status === "failed" ||
      (step.status !== "passed" &&
        step.exitCode !== undefined &&
        step.exitCode !== 0 &&
        !classified.some(
          (blocker) => blocker.step === step.name && blocker.reproducedBy.includes("failure"),
        )),
  );
  return {
    ok: unexpectedAttempts.length === 0 && staleBlockers.length === 0 && failedSteps.length === 0,
    steps,
    blockers: classified,
    attempts,
    unexpectedAttempts,
    staleBlockers,
    failedSteps,
  };
}

const cell = (value) =>
  String(value ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");

/** @param {ReturnType<typeof classifyNodeSpawns> & {bunVersion?: string, bunRevision?: string}} result */
export function renderMarkdownReport(result) {
  const lines = [
    `# Bun-only runtime smoke: ${result.ok ? "PASS" : "FAIL"}`,
    "",
    `Bun ${cell(result.bunVersion ?? "unknown")} (${cell(result.bunRevision ?? "unknown")})`,
    "",
    "| Step | Result | Seconds |",
    "| --- | --- | ---: |",
    ...result.steps.map((step) => {
      const duration = step.durationMs ?? step.endMs - step.startMs;
      return `| ${cell(step.name)} | ${cell(step.status ?? step.exitCode)} | ${Number.isFinite(duration) ? (duration / 1000).toFixed(2) : ""} |`;
    }),
    "",
    "| Expected blocker | Origin | Result | Attempts | Evidence / reason |",
    "| --- | --- | --- | ---: | --- |",
    ...result.blockers.map((blocker) => {
      const detail =
        blocker.status === "stale"
          ? "Delete this entry from expected-node-blockers.json."
          : blocker.status === "not-exercised"
            ? blocker.notExercisedReason
            : blocker.reproducedBy.join(", ");
      return `| ${cell(blocker.id)} | ${cell(blocker.origin)} | ${blocker.status} | ${blocker.matchedAttempts.length} | ${cell(detail)} |`;
    }),
  ];
  if (result.failedSteps.length > 0) {
    lines.push("", `Failed steps: ${result.failedSteps.map((step) => step.name).join(", ")}.`);
  }
  for (const attempt of result.unexpectedAttempts) {
    lines.push(
      "",
      `## Unexpected Node attempt (${cell(attempt.step ?? "outside recorded steps")})`,
      "",
      `PID ${attempt.pid}, parent ${attempt.ppid}; cwd ${JSON.stringify(attempt.cwd ?? "unknown")}`,
      "",
      "```text",
      JSON.stringify(attempt.argv),
      ...attempt.ancestors.map(
        (ancestor) =>
          `ancestor ${ancestor.pid}: ${JSON.stringify(ancestor.cmdline.replace(/\0+$/, "").replaceAll("\0", " "))}`,
      ),
      ...attempt.stack
        .filter((frame) => !/spawn-trace-preload\.mjs|node:child_process/.test(frame))
        .slice(0, 8),
      "```",
    );
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Measure restart preparation through its exported owner, including real worker reads.
 * Seed with scripts/perf/session-read-transactions-fixture.mjs, then run:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/restart-resume-measure.ts \
 *   --root <synthetic-fixture> --baseline <saved-session-restart-resume.ts> \
 *   --output <new-report.json> [--control] [--allocation] [--seed]
 * Five counterbalanced pairs; use --control for A/A and separate allocation runs.
 * --seed adds eight interrupted turns and four shutdown markers to the offline fixture.
 * --resume measures selection and terminal settlement; model admission is counted only.
 * It reseeds four predecessor runs and eight older orphans before each measured call.
 * --markers instead marks the four eligible rows to measure graceful marker precedence.
 * Both arms expect four resumes; --baseline-resumes 12 measures the retired orphan policy.
 * The context provides only preparation's configuration; returned admission work is
 * never invoked unless --resume is selected. Neither mode measures Gateway readiness.
 * Process CPU includes workers; sampled allocation covers only the host isolate.
 * --mark measures shutdown marker persistence for 60 live run-registry owners.
 * --heap-mib retains numeric arrays across collections to exercise a large old heap.
 * --shutdown-baseline pins server-run-shutdown.ts; --cancel-dependent holds subagent
 * settlement until received-work cancellation, under --shutdown-budget-ms (default 85000).
 * --workspace uses real event and reply admission plus workspace preparation, replacing only
 * model dispatch with immediate completion. Supply --handoff-baseline and optionally
 * --handoff-candidate; --workspace-ready measures already-ready sessions separately.
 * This is owner proof, not model cancellation or a complete Gateway shutdown.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    baseline: { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "10" },
    control: { type: "boolean" },
    allocation: { type: "boolean" },
    seed: { type: "boolean" },
    resume: { type: "boolean" },
    markers: { type: "boolean" },
    mark: { type: "boolean" },
    "heap-mib": { type: "string", default: "0" },
    "shutdown-baseline": { type: "string" },
    "subagent-ms": { type: "string", default: "0" },
    "cancel-dependent": { type: "boolean" },
    "shutdown-budget-ms": { type: "string", default: "85000" },
    "baseline-resumes": { type: "string", default: "4" },
    workspace: { type: "boolean" },
    "workspace-ready": { type: "boolean" },
    "handoff-baseline": { type: "string" },
    "handoff-candidate": { type: "string" },
  },
});
assert(values.root && values.baseline && values.output && global.gc);
assert(!existsSync(values.output), "Refusing to overwrite evidence");
assert(!values.markers || values.resume, "--markers requires --resume");
assert(!values.workspace || (values.resume && values.markers && values["handoff-baseline"]));
assert(!values.mark || !values.resume, "--mark and --resume are separate workloads");
assert(!values["shutdown-baseline"] || values.mark, "--shutdown-baseline requires --mark");
assert(!values["cancel-dependent"] || values["shutdown-baseline"]);
const shutdownBudgetMs = parseStrictIntegerOption({
  raw: values["shutdown-budget-ms"],
  label: "--shutdown-budget-ms",
  min: 1,
  fallback: 85_000,
});
const subagentMs = parseStrictIntegerOption({
  raw: values["subagent-ms"],
  label: "--subagent-ms",
  min: 0,
  fallback: 0,
});
const heapMiB = parseStrictIntegerOption({
  raw: values["heap-mib"],
  label: "--heap-mib",
  min: 0,
  fallback: 0,
});
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 10,
});
const baselineResumes = parseStrictIntegerOption({
  raw: values["baseline-resumes"],
  label: "--baseline-resumes",
  min: 1,
  fallback: 4,
});
assert(baselineResumes <= 12, "--baseline-resumes cannot exceed the 12 seeded runs");
const root = path.resolve(values.root);
const fixture = JSON.parse(readFileSync(path.join(root, "fixture.json"), "utf8"));
assert.equal(fixture.format, "openclaw-session-read-transactions-v1");
process.env = {
  ...createGatewayBenchEnv(path.join(root, "home"), path.join(root, "openclaw.json"), {
    startupTrace: false,
  }),
  OPENCLAW_STATE_DIR: root,
  TMPDIR: path.join(root, "tmp"),
};
const cfg: OpenClawConfig = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH!, "utf8"));
const agent = await import("../../src/state/openclaw-agent-db.js");
const state = await import("../../src/state/openclaw-state-db.js");
const { readConfigMachineState } = await import("../../src/state/config-machine-state.js");
const { writeConfigMachineState } = await import("../../src/state/config-machine-state-write.js");
agent.openOpenClawAgentDatabase({ agentId: "main" });
if (values.seed) {
  const { writeSessionEntry } =
    await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
  agent.runOpenClawAgentWriteTransaction(
    (owned) => {
      const rows = owned.db
        .prepare("SELECT session_key, entry_json FROM session_nodes ORDER BY session_key LIMIT 12")
        .all();
      assert.equal(rows.length, 12);
      for (const [index, row] of rows.entries()) {
        const entry = JSON.parse(String(row.entry_json));
        writeSessionEntry(owned, String(row.session_key), {
          ...entry,
          ...(index < 8
            ? {
                lifecycleRunId: `synthetic-interrupted-${index}`,
                activeWriterRunId: `synthetic-interrupted-${index}`,
                startedAt: entry.updatedAt,
              }
            : { resumeAfterRestart: { queuedInputIds: [] } }),
        });
      }
    },
    { agentId: "main" },
  );
}
const canonical = new URL("../../src/gateway/session-restart-resume.ts", import.meta.url).href;
const sources = [readFileSync(values.baseline, "utf8"), readFileSync(new URL(canonical), "utf8")];
if (values.control) {
  sources[1] = sources[0]!;
}
const urls = sources.map((_, arm) => `${canonical}?restart-measure=${arm}`);
const shutdownCanonical = new URL("../../src/gateway/server-run-shutdown.ts", import.meta.url).href;
const shutdownSources = values["shutdown-baseline"]
  ? [
      readFileSync(values["shutdown-baseline"], "utf8"),
      readFileSync(new URL(shutdownCanonical), "utf8"),
    ]
  : [];
if (values.control && shutdownSources.length) {
  shutdownSources[1] = shutdownSources[0]!;
}
const shutdownUrls = shutdownSources.map((_, arm) => `${shutdownCanonical}?restart-measure=${arm}`);
const loaded = new Set<string>();
const handoff = new URL("../../src/auto-reply/reply/session-event-handoff.ts", import.meta.url);
const countedHandoff = `${handoff.href}?restart-resume-measure`;
const handoffSources = values.workspace
  ? [
      readFileSync(values["handoff-baseline"]!, "utf8"),
      readFileSync(values["handoff-candidate"] ?? handoff, "utf8"),
    ]
  : [];
if (values.control && handoffSources.length) {
  handoffSources[1] = handoffSources[0]!;
}
const handoffUrls = handoffSources.map((_, arm) => `${handoff.href}?workspace-measure=${arm}`);
const measuredDispatch = new URL(
  "../../src/auto-reply/dispatch.ts?workspace-measure",
  import.meta.url,
).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      values.resume &&
      urls.includes(context.parentURL ?? "") &&
      specifier.endsWith("session-event-handoff.js")
    ) {
      return {
        url: handoffUrls[urls.indexOf(context.parentURL!)] ?? countedHandoff,
        shortCircuit: true,
      };
    }
    if (handoffUrls.includes(context.parentURL ?? "") && specifier === "../dispatch.js") {
      return { url: measuredDispatch, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === measuredDispatch) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import { channel } from "node:diagnostics_channel";
          import { admitReplyTurn } from "./reply/reply-turn-admission.ts";
          export async function dispatchInboundMessageWithRoutedChannelDispatcher(params) {
            const options = params.replyOptions;
            const event = options.internalEventExecution;
            const admission = await admitReplyTurn({
              agentId: params.ctx.AgentId, sessionKey: params.ctx.SessionKey,
              sessionId: options.expectedExistingSessionId,
              expectedSessionId: options.expectedExistingSessionId,
              storePath: params.cfg.session.store, kind: "visible", resetTriggered: false,
              upstreamAbortSignal: options.abortSignal, assertRequestCurrent: event.assertCurrent,
            });
            if (admission.status !== "owned") throw admission.error ?? new Error(admission.reason);
            try {
              options.onReplyOperationAdmitted(admission.operation);
              await event.beforeStart();
              event.onStarted();
              channel("openclaw.perf.restart-resume-admission").publish(params.ctx.SessionKey);
              return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
            } finally { admission.operation.complete(); }
          }`,
      };
    }
    const handoffArm = handoffUrls.indexOf(url);
    if (handoffArm >= 0) {
      return {
        format: "module",
        shortCircuit: true,
        source:
          stripTypeScriptTypes(
            handoffSources[handoffArm]!.replace(
              "export function enqueueSessionEventForHost(",
              "function enqueueSessionEventForHost(",
            ),
          ) +
          `
          import { channel as workspaceMeasureChannel } from "node:diagnostics_channel";
          export function measuredEnqueue(text, options) {
            const receipt = enqueueSessionEventForHost(text, options);
            workspaceMeasureChannel("openclaw.perf.restart-resume-receipt").publish(receipt);
            return receipt;
          }
          export { measuredEnqueue as enqueueSessionEventForHost };`,
      };
    }
    const shutdownArm = shutdownUrls.indexOf(url);
    if (shutdownArm >= 0) {
      return {
        format: "module",
        source: stripTypeScriptTypes(shutdownSources[shutdownArm]!),
        shortCircuit: true,
      };
    }
    if (url === countedHandoff) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          import { channel } from "node:diagnostics_channel";
          export { captureSessionEventTargetForHost } from "./session-event-target.ts";
          export function enqueueSessionEventForHost(text, options) {
            options.expectedTarget.assertCurrent?.();
            channel("openclaw.perf.restart-resume-admission").publish(options.sessionKey);
            return {
              accepted: Promise.resolve({ok: true}), id: "synthetic-restart-input",
              settled: Promise.resolve({status: "completed", executionStarted: true, delivered: false}),
              cancel: () => false,
            };
          }`,
      };
    }
    const arm = urls.indexOf(url);
    if (arm < 0) {
      return nextLoad(url, context);
    }
    loaded.add(url);
    return { format: "module", source: stripTypeScriptTypes(sources[arm]!), shortCircuit: true };
  },
});
type MeasureInput = {
  context: {
    getRuntimeConfig: () => OpenClawConfig;
    restartResumeWindow?: { startedAt: number; endedAt: number };
    restartResumeWindows?: Record<string, Array<{ startedAt: number; endedAt: number }>>;
  };
  signal: AbortSignal;
  log: { warn: (message: string) => void };
};
type Owner = {
  persistRunningSessionsForRestart(input: {
    cfg: OpenClawConfig;
    signal?: AbortSignal;
  }): Promise<void>;
  resumeMarkedSessions(input: MeasureInput): Promise<void>;
  prepareAgentRestartRecovery(input: {
    context: { getRuntimeConfig: () => OpenClawConfig };
    signal: AbortSignal;
    log: { warn: (message: string) => void };
    agentId: string;
    env: NodeJS.ProcessEnv;
    assertCurrent: () => void;
  }): Promise<undefined | (() => Promise<void>)>;
};
const owners: Owner[] = [];
for (const url of urls) {
  owners.push(await import(url));
}
assert.equal(loaded.size, 2);
const shutdownOwners: Array<typeof import("../../src/gateway/server-run-shutdown.js")> = [];
for (const url of shutdownUrls) {
  shutdownOwners.push(await import(url));
}
const { runWithProcessCleanupBudget } =
  await import("../../src/process/supervisor/cleanup-budget.js");
const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
setRuntimeConfigSnapshot(cfg);
const signal = new AbortController().signal;
const makeContext = () => {
  const context = {
    getRuntimeConfig: () => cfg,
    getSessionEventSubscriberConnIds: () => new Set<string>(),
    resolveGatewayContext: () => context,
  };
  return context;
};
const context = makeContext();
const warnings: string[] = [];
const input = {
  context,
  signal,
  agentId: "main",
  env: process.env,
  assertCurrent() {},
  log: {
    warn(message: string) {
      if (values.workspace) {
        warnings.push(message);
      } else {
        throw new Error(message);
      }
    },
  },
};
const { writeSessionEntry, readExactSessionEntryRow } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const seededRows = agent
  .openOpenClawAgentDatabase({ agentId: "main" })
  .db.prepare(
    `SELECT session_key, entry_json FROM session_nodes ORDER BY session_key LIMIT ${values.mark ? 60 : 12}`,
  )
  .all()
  .map((row) => ({
    sessionKey: String(row.session_key),
    entry: JSON.parse(String(row.entry_json)),
  }));
const predecessor = { startedAt: Date.now() - 60_000, endedAt: Date.now() };
const registry = await import("../../src/infra/agent-run-registry.js");
const claims = values.mark
  ? seededRows.map(({ sessionKey, entry }, index) => {
      const runId = `synthetic-shutdown-${index}`;
      return {
        runId,
        claim: registry.claimAgentRunContext(
          runId,
          { agentId: "main", sessionKey, sessionId: entry.sessionId },
          { trackOwner: true, ownsContext: true },
        ),
      };
    })
  : [];
const retainedHeap = Array.from({ length: heapMiB }, (_, index) =>
  Array.from({ length: (1024 * 1024) / 8 }, () => index),
);
global.gc();
const retainedHeapUsed = process.memoryUsage().heapUsed;
const seedMarkers = () =>
  agent.runOpenClawAgentWriteTransaction(
    (owned) => {
      assert.equal(seededRows.length, 60);
      for (const { sessionKey, entry } of seededRows) {
        writeSessionEntry(owned, sessionKey, { ...entry, resumeAfterRestart: undefined });
      }
    },
    { agentId: "main" },
  );
let workspaceBinding: import("../../src/config/sessions/types.js").SessionEntry["worktree"] =
  seededRows[0]?.entry.worktree;
const seedResume = () => {
  // Include the candidate's durable acknowledgement; fixture writes stay outside timing.
  writeConfigMachineState("gateway.restartRecovery", { main: [predecessor] });
  agent.runOpenClawAgentWriteTransaction(
    (owned) => {
      assert.equal(seededRows.length, 12);
      for (const [index, row] of seededRows.entries()) {
        writeSessionEntry(owned, row.sessionKey, {
          ...row.entry,
          ...(values.workspace
            ? { pendingWorktree: undefined, pendingProjectGitUrl: undefined }
            : {}),
          ...(values.workspace && index === 0 && !values["workspace-ready"]
            ? {
                worktree: workspaceBinding,
                pendingWorktree: {
                  workspace: path.join(root, "workspace"),
                  titleSource: "",
                  name: "resume-workspace-measure",
                },
              }
            : {}),
          status: undefined,
          abortedLastRun: false,
          endedAt: undefined,
          lastRunId: undefined,
          lifecycleRunId: `synthetic-interrupted-${index}`,
          activeWriterRunId: `synthetic-interrupted-${index}`,
          updatedAt: predecessor.endedAt,
          startedAt: index < 4 ? predecessor.startedAt + 1 : predecessor.startedAt - 86_400_000,
          resumeAfterRestart: values.markers && index < 4 ? { queuedInputIds: [] } : undefined,
        });
      }
    },
    { agentId: "main" },
  );
};
let admissions = 0;
const admissionOrder: string[] = [];
const receipts: Array<Promise<unknown>> = [];
const receiptDiagnostics = channel("openclaw.perf.restart-resume-receipt");
const onReceipt = (receipt: unknown) => {
  receipts.push((receipt as { settled: Promise<unknown> }).settled);
};
receiptDiagnostics.subscribe(onReceipt);
const admissionDiagnostics = channel("openclaw.perf.restart-resume-admission");
const onAdmission = (key: unknown) => {
  admissionOrder.push(String(key));
  admissions++;
};
admissionDiagnostics.subscribe(onAdmission);
const shutdownTimings: Array<{
  cancelMs?: number;
  prepareMs: number;
  releasedMs: number;
  failed: boolean;
}> = [];
const measureOwner = async (arm: number) => {
  if (values.mark) {
    const shutdown = shutdownOwners[arm];
    if (shutdown) {
      const start = performance.now();
      let cancelMs: number | undefined;
      const cancelled = Promise.withResolvers<void>();
      const keepAlive = setTimeout(() => {}, shutdownBudgetMs + subagentMs + 1_000);
      const result = await runWithProcessCleanupBudget(
        { deadline: start + shutdownBudgetMs, warn: console.warn },
        () =>
          shutdown.prepareGatewayRunShutdown({
            resolveGatewayContext: () => undefined,
            warnings: [],
            persistRunningSessionsForRestart: (markerSignal) =>
              owners[arm]!.persistRunningSessionsForRestart({ cfg, signal: markerSignal }),
            terminateRunningSubagentsForShutdown: () =>
              values["cancel-dependent"] ? cancelled.promise : delay(subagentMs),
            cancelReceivedWork: () => {
              cancelMs = performance.now() - start;
              cancelled.resolve();
            },
          }),
      );
      const prepareMs = performance.now() - start;
      await result.released;
      clearTimeout(keepAlive);
      shutdownTimings.push({
        cancelMs,
        prepareMs,
        releasedMs: performance.now() - start,
        failed: Boolean(result.failure),
      });
      if (!values["cancel-dependent"]) {
        assert.equal(result.failure, undefined);
      }
    } else {
      await owners[arm]!.persistRunningSessionsForRestart({ cfg, signal });
    }
  } else if (values.resume) {
    await owners[arm]!.resumeMarkedSessions({
      ...input,
      context: {
        ...makeContext(),
        // Supply both owner contracts when comparing a saved pre-ledger implementation.
        restartResumeWindow: predecessor,
        restartResumeWindows: { main: [predecessor] },
      },
    });
    if (values.workspace) {
      await Promise.all(receipts.splice(0));
    }
  } else {
    assert.equal(typeof (await owners[arm]!.prepareAgentRestartRecovery(input)), "function");
  }
};
const retainWorkspaceBinding = () => {
  if (values.workspace) {
    const entry = readExactSessionEntryRow(
      agent.openOpenClawAgentDatabase({ agentId: "main" }),
      seededRows[0]!.sessionKey,
    )?.entry;
    workspaceBinding = entry?.worktree ?? workspaceBinding;
  }
};
const inspector = new Session();
const samples = [];
let completedHistoryTasks = 0;
const taskDiagnostics = channel("openclaw.worker.task");
const onTask = (value: unknown) => {
  if (
    value &&
    typeof value === "object" &&
    "worker" in value &&
    typeof value.worker === "string" &&
    value.worker.startsWith("session-transcript.worker")
  ) {
    completedHistoryTasks++;
  }
};
taskDiagnostics.subscribe(onTask);
try {
  // A short synthetic process deadline must not accidentally measure cold worker bootstrap.
  const markerWarmupStarted = performance.now();
  if (shutdownOwners.length) {
    await owners[0]!.persistRunningSessionsForRestart({ cfg, signal });
  }
  const markerWarmupMs = shutdownOwners.length
    ? performance.now() - markerWarmupStarted
    : undefined;
  // Startup preparation and worker initialization are distinct from warmed discovery.
  if (values.resume) {
    seedResume();
  }
  if (values.mark) {
    seedMarkers();
  }
  const coldStarted = performance.now();
  await measureOwner(0);
  const coldMs = performance.now() - coldStarted;
  retainWorkspaceBinding();
  if (values.resume) {
    seedResume();
  }
  if (values.mark) {
    seedMarkers();
  }
  const coldCandidateStarted = performance.now();
  await measureOwner(1);
  const coldCandidateMs = performance.now() - coldCandidateStarted;
  retainWorkspaceBinding();
  if (values.allocation) {
    inspector.connect();
  }
  for (let pair = 0; pair < 5; pair++) {
    for (const arm of pair % 2 ? [1, 0] : [0, 1]) {
      shutdownTimings.length = 0;
      let wallMs = 0;
      let processCpuMs = 0;
      let threadCpuMs = 0;
      let sampledBytes = 0;
      let workerTasks = 0;
      const hostLoad = loadavg();
      const admissionsBefore = admissions;
      const orderBefore = admissionOrder.length;
      for (let iteration = 0; iteration < iterations; iteration++) {
        if (values.resume) {
          seedResume();
        }
        if (values.mark) {
          seedMarkers();
        }
        global.gc();
        if (values.allocation) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const tasksBefore = completedHistoryTasks;
        const processCpu = process.cpuUsage();
        const threadCpu = process.threadCpuUsage();
        const started = performance.now();
        await measureOwner(arm);
        wallMs += performance.now() - started;
        const usedProcess = process.cpuUsage(processCpu);
        const usedThread = process.threadCpuUsage(threadCpu);
        processCpuMs += (usedProcess.user + usedProcess.system) / 1000;
        threadCpuMs += (usedThread.user + usedThread.system) / 1000;
        workerTasks += completedHistoryTasks - tasksBefore;
        if (values.allocation) {
          sampledBytes += sumSampledHeapBytes(
            (await inspector.post("HeapProfiler.stopSampling")).profile.head,
          );
        }
        retainWorkspaceBinding();
        if (values.resume && arm === 1 && !values.control) {
          assert.equal(readConfigMachineState("gateway.restartRecovery"), undefined);
        }
        if (values.mark) {
          assert.equal(
            seededRows.filter(
              ({ sessionKey }) =>
                readExactSessionEntryRow(
                  agent.openOpenClawAgentDatabase({ agentId: "main" }),
                  sessionKey,
                )?.entry.resumeAfterRestart,
            ).length,
            60,
          );
        }
      }
      const resumedPerCall = (admissions - admissionsBefore) / iterations;
      const settledStaleRuns = values.resume
        ? seededRows.slice(4).filter(({ sessionKey }) => {
            const row = readExactSessionEntryRow(
              agent.openOpenClawAgentDatabase({ agentId: "main" }),
              sessionKey,
            )?.entry;
            return row?.status === "killed" && row.lifecycleRunId === undefined;
          }).length
        : undefined;
      if (values.resume) {
        const expectedResumes = arm === 0 || values.control ? baselineResumes : 4;
        assert.equal(resumedPerCall, expectedResumes);
        assert.equal(settledStaleRuns, values.workspace ? 8 : 12 - expectedResumes);
        if (values.workspace) {
          assert.deepEqual(
            admissionOrder.slice(orderBefore).slice(-expectedResumes),
            seededRows.slice(4 - expectedResumes, 4).map((row) => row.sessionKey),
          );
        }
      }
      samples.push({
        pair,
        arm,
        wallMs: wallMs / iterations,
        processCpuMs: processCpuMs / iterations,
        threadCpuMs: threadCpuMs / iterations,
        sampledBytes: values.allocation ? sampledBytes / iterations : undefined,
        historyWorkerTasksPerPreparation: workerTasks / iterations,
        resumedPerCall: values.resume ? resumedPerCall : undefined,
        admissionOrder: values.workspace ? admissionOrder.slice(orderBefore) : undefined,
        markedPerCall: values.mark ? 60 : undefined,
        shutdownTimings: shutdownTimings.slice(),
        settledStaleRuns,
        hostLoad,
      });
    }
  }
  writeFileSync(
    values.output,
    `${JSON.stringify(
      {
        scope: values.mark
          ? "Exported shutdown marker persistence; 60 live run-registry owners; real SQLite writes; no model cancellation or complete Gateway shutdown"
          : values.workspace
            ? "Exported restart recovery through real session-event/reply admission and managed-workspace binding; immediate synthetic model completion; no Gateway transport or model execution"
            : values.resume
              ? "Exported restart selection and terminal settlement; real SQLite reads/writes; model admission counted only"
              : "Exported restart preparation; real SQLite worker reads; no resume admission",
        workspace: values.workspace ?? false,
        workspaceReady: values["workspace-ready"] ?? false,
        handoffSourceHashes: handoffSources.map((source) =>
          createHash("sha256").update(source).digest("hex"),
        ),
        warnings: values.workspace ? warnings : undefined,
        markers: values.markers ?? false,
        node: process.version,
        mode: values.allocation ? "allocation" : "timing",
        control: values.control ?? false,
        iterations,
        heapMiB,
        subagentMs,
        cancelDependent: values["cancel-dependent"] ?? false,
        shutdownBudgetMs,
        markerWarmupMs,
        retainedHeapUsed,
        baselineResumes,
        coldFirstArmMs: coldMs,
        coldSecondArmMs: coldCandidateMs,
        fixture,
        sourceHashes: sources.map((source) => createHash("sha256").update(source).digest("hex")),
        shutdownSourceHashes: shutdownSources.map((source) =>
          createHash("sha256").update(source).digest("hex"),
        ),
        samples,
      },
      null,
      2,
    )}\n`,
  );
  console.log(JSON.stringify({ output: values.output, samples }));
} finally {
  assert.equal(retainedHeap.length, heapMiB);
  for (const { runId, claim } of claims) {
    registry.releaseAgentRunContext(runId, claim);
  }
  taskDiagnostics.unsubscribe(onTask);
  admissionDiagnostics.unsubscribe(onAdmission);
  receiptDiagnostics.unsubscribe(onReceipt);
  inspector.disconnect();
  await agent.closeOpenClawAgentDatabasesAsync();
  await state.closeOpenClawStateDatabaseAsync();
}

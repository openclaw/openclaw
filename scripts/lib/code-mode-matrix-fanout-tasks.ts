import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createGatewayMatrixPluginSource } from "./code-mode-matrix-gateway-fixtures.ts";
import type {
  MatrixPerformanceEvaluation,
  MatrixPerformanceFixture,
} from "./code-mode-matrix-performance-types.ts";

export const FANOUT_MATRIX_TASKS = ["fanout-dependency"] as const;
export type FanoutMatrixTask = (typeof FANOUT_MATRIX_TASKS)[number];

export function isFanoutMatrixTask(task: string): task is FanoutMatrixTask {
  return FANOUT_MATRIX_TASKS.some((candidate) => candidate === task);
}

const STAGES = ["A", "B", "C", "D", "E", "F", "G"] as const;
const SHARDS = STAGES.slice(0, 4);
const ARTIFACT = "fanout-result.json";
const READ_TOOL = "matrix_fanout_read";
const SUBMIT_TOOL = "matrix_fanout_submit";
const UNAVAILABLE_SOURCE = "legacy-returns";

type Report = {
  stage: string;
  nonce: string;
  rowCount: number;
  eligibleCount: number;
  totalCents: number;
  excludedIds: string[];
  unavailableSources: string[];
  auditPassed: boolean;
};

const REPORT_SCHEMA = {
  type: "object",
  properties: {
    stage: { type: "string", enum: STAGES },
    nonce: { type: "string" },
    rowCount: { type: "integer", minimum: 0 },
    eligibleCount: { type: "integer", minimum: 0 },
    totalCents: { type: "integer", minimum: 0 },
    excludedIds: { type: "array", items: { type: "string" } },
    unavailableSources: { type: "array", items: { type: "string" } },
    auditPassed: { type: "boolean" },
  },
  required: [
    "stage",
    "nonce",
    "rowCount",
    "eligibleCount",
    "totalCents",
    "excludedIds",
    "unavailableSources",
    "auditPassed",
  ],
  additionalProperties: false,
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function childLifecycleChecks(
  rows: readonly unknown[],
  labels: readonly string[],
  taskResponseAt: number | undefined,
) {
  const children = rows.filter(isRecord);
  const byLabel = new Map(children.map((row) => [row.label, row]));
  const selected = labels.map((label) => byLabel.get(label));
  const exactChildren =
    children.length === STAGES.length &&
    selected.every((row) => row !== undefined) &&
    new Set(children.map((row) => row.runId)).size === STAGES.length &&
    children.every((row) => typeof row.runId === "string" && row.runId.length > 0);
  const settledChildren =
    exactChildren &&
    children.every(
      (row) =>
        row.runtime === "subagent" &&
        row.status === "succeeded" &&
        finite(row.createdAt) &&
        finite(row.startedAt) &&
        finite(row.endedAt) &&
        row.createdAt <= row.startedAt &&
        row.startedAt <= row.endedAt,
    );
  const flatChildren =
    exactChildren &&
    new Set(children.map((row) => row.childSessionKey)).size === STAGES.length &&
    children.every(
      (row) =>
        typeof row.childSessionKey === "string" &&
        row.childSessionKey.includes(":subagent:") &&
        typeof row.requesterSessionKey === "string" &&
        row.requesterSessionKey.length > 0 &&
        !row.requesterSessionKey.includes(":subagent:"),
    ) &&
    new Set(children.map((row) => row.requesterSessionKey)).size === 1;
  const after = (stage: number, prerequisites: number[]) => {
    const createdAt = selected[stage]?.createdAt;
    return (
      finite(createdAt) &&
      prerequisites.every((index) => {
        const endedAt = selected[index]?.endedAt;
        return finite(endedAt) && createdAt >= endedAt;
      })
    );
  };
  const events = children.flatMap((row) =>
    finite(row.startedAt) && finite(row.endedAt)
      ? [
          { at: row.startedAt, delta: 1 },
          { at: row.endedAt, delta: -1 },
        ]
      : [],
  );
  let active = 0;
  let peak = 0;
  for (const event of events.toSorted((a, b) => a.at - b.at || a.delta - b.delta)) {
    active += event.delta;
    peak = Math.max(peak, active);
  }
  return {
    exactChildren,
    settledChildren,
    completedByResponse:
      settledChildren &&
      finite(taskResponseAt) &&
      children.every((row) => finite(row.endedAt) && row.endedAt <= taskResponseAt),
    flatChildren,
    dependencyOrder: settledChildren && after(5, [0, 1, 2, 3]) && after(6, [4, 5]),
    boundedConcurrency: settledChildren && peak <= 3,
  };
}

export function createFanoutMatrixFixture(
  _task: FanoutMatrixTask,
  repetition: number,
): MatrixPerformanceFixture {
  const nonce = `fanout-r${repetition}-v1`;
  const labels = STAGES.map((stage) => `${nonce}-${stage}`);
  const datasets = Object.fromEntries(
    SHARDS.map((stage, shard) => [
      stage,
      Array.from({ length: 17 }, (_, index) => {
        const cents = 100 + shard * 271 + index * 37 + repetition * 11;
        return {
          id: `${stage}-${String(index + 1).padStart(2, "0")}`,
          status: index % 5 === 0 ? "void" : "posted",
          amountCents: index % 7 === 0 ? null : index % 3 === 0 ? String(cents) : cents,
        };
      }),
    ]),
  );
  const empty = (stage: string): Report => ({
    stage,
    nonce,
    rowCount: 0,
    eligibleCount: 0,
    totalCents: 0,
    excludedIds: [],
    unavailableSources: [],
    auditPassed: false,
  });
  const shards = SHARDS.map((stage) => {
    const rows = datasets[stage]!;
    const eligible = rows.filter((row) => row.status === "posted" && row.amountCents !== null);
    const report = empty(stage);
    report.rowCount = rows.length;
    report.eligibleCount = eligible.length;
    report.totalCents = eligible.reduce((sum, row) => sum + Number(row.amountCents), 0);
    report.excludedIds = rows.filter((row) => !eligible.includes(row)).map((row) => row.id);
    return report;
  });
  const availability = { ...empty("E"), unavailableSources: [UNAVAILABLE_SOURCE] };
  const reconciliation = empty("F");
  for (const shard of shards) {
    reconciliation.rowCount += shard.rowCount;
    reconciliation.eligibleCount += shard.eligibleCount;
    reconciliation.totalCents += shard.totalCents;
    reconciliation.excludedIds.push(...shard.excludedIds);
  }
  const audit = {
    ...reconciliation,
    stage: "G",
    unavailableSources: [UNAVAILABLE_SOURCE],
    auditPassed: true,
  };
  const expected = { nonce, shards, availability, reconciliation, audit };
  const reports = [...shards, availability, reconciliation, audit];
  const pluginSource = createGatewayMatrixPluginSource(`
const datasets = ${JSON.stringify(datasets)};
const reportSchema = ${JSON.stringify(REPORT_SCHEMA)};
api.registerTool({ contextVersion: 2, create(ctx) {
  function caller() {
    const sessionKey = ctx.sessionKey;
    if (typeof sessionKey !== "string" || !sessionKey.includes(":subagent:")) {
      throw new Error("This work belongs to an actual collector child; delegate it.");
    }
    ctx.assertInvocationCurrent();
    return sessionKey;
  }
  return [{
    name: ${JSON.stringify(READ_TOOL)}, label: "Read fanout source",
    description: "Read one complete A-D invoice shard or E's optional legacy-source availability. Only collector children may call this tool.",
    parameters: { type: "object", properties: { stage: { type: "string", enum: ["A", "B", "C", "D", "E"] } }, required: ["stage"], additionalProperties: false },
    async execute(_id, input) {
      const sessionKey = caller();
      const stage = input.stage;
      record("fanout-read", ${JSON.stringify(READ_TOOL)}, { stage, sessionKey, at: Date.now() });
      return result(stage === "E"
        ? { nonce: ${JSON.stringify(nonce)}, stage, source: ${JSON.stringify(UNAVAILABLE_SOURCE)}, status: "unavailable", reason: "The synthetic legacy source is offline. Preserve this business outcome." }
        : { nonce: ${JSON.stringify(nonce)}, stage, records: datasets[stage] });
    }
  }, {
    name: ${JSON.stringify(SUBMIT_TOOL)}, label: "Submit fanout report",
    description: "Record the calling child's own computed report. Each stage and child may submit once. F requires A-D reports; G requires E and F reports. Return this report as the child's structured collector result afterward.",
    parameters: { type: "object", properties: { report: reportSchema }, required: ["report"], additionalProperties: false },
    outputSchema: reportSchema,
    async execute(_id, input) {
      const sessionKey = caller();
      const report = input.report;
      const submitted = receipts().filter(row => row.kind === "fanout-submit");
      if (report.nonce !== ${JSON.stringify(nonce)}) throw new Error("Report nonce does not match this work.");
      if (submitted.some(row => row.stage === report.stage || row.sessionKey === sessionKey)) {
        throw new Error("This stage or child already submitted; do not repeat it.");
      }
      const prerequisites = report.stage === "F" ? ["A", "B", "C", "D"] : report.stage === "G" ? ["E", "F"] : [];
      if (!prerequisites.every(stage => submitted.some(row => row.stage === stage))) {
        throw new Error("Required predecessor reports have not been submitted.");
      }
      if (["A", "B", "C", "D", "E"].includes(report.stage) && !receipts().some(row => row.kind === "fanout-read" && row.stage === report.stage && row.sessionKey === sessionKey)) {
        throw new Error("Read your stage's complete source before submitting.");
      }
      ctx.assertInvocationCurrent();
      record("fanout-submit", ${JSON.stringify(SUBMIT_TOOL)}, { stage: report.stage, sessionKey, at: Date.now(), report });
      return result(report);
    }
  }];
}}, { names: [${JSON.stringify(READ_TOOL)}, ${JSON.stringify(SUBMIT_TOOL)}] });
`);
  return {
    rubricVersion: "fanout-dependency-v1",
    deliveredFiles: [ARTIFACT],
    requiredTools: [READ_TOOL, SUBMIT_TOOL],
    allowedTools: [
      READ_TOOL,
      SUBMIT_TOOL,
      "sessions_spawn",
      "agents_wait",
      "read",
      "write",
      "edit",
      "exec",
      "process",
    ],
    pluginSource,
    inspectSubagents: true,
    configPatch: {
      agents: { defaults: { subagents: { maxSpawnDepth: 1 } } },
      tools: { swarm: { maxConcurrent: 3, maxChildrenPerGroup: 7, maxTotalPerGroup: 7 } },
    },
    prompt: `Reconcile four synthetic invoice shards and audit the result using exactly seven native collector children. This is one bounded job, ${nonce}. Keep the group flat: every child belongs directly to you and must not delegate. Do not use ACP or announcing children. Do not repeat a launch or a submitted report.

Use the labels ${labels.join(", ")}, corresponding to stages A through G. Start the independent A-E children before collecting their results, so the available concurrency can be used. Then collect all five results. Start F only after A-D have finished. Start G only after E and F have finished. Use one group for the job; running capacity is three children. Keep every accepted child ID and collect all seven terminal outcomes before answering.

Every child must submit its own report once with ${SUBMIT_TOOL}, then finish with that same report as its structured collector result. Supply this output schema when creating each collector: ${JSON.stringify(REPORT_SCHEMA)}.

A-D: each child calls ${READ_TOOL} for its own stage. Compute over every returned record. Eligible rows have status posted and a non-null amountCents; decimal numeric strings are valid cents. rowCount counts all records, eligibleCount counts eligible records, totalCents sums eligible cents, and excludedIds lists every excluded row ID in ascending order. Set unavailableSources to [] and auditPassed to false.
E: call ${READ_TOOL} with stage E. Preserve the unavailable source as a business outcome, with unavailableSources containing its source name. Do not pretend it succeeded. Set all counts and totals to zero, excludedIds to [], and auditPassed to false. This is a successful report of source unavailability, not a failed child run.
F: give this child the complete collected A-D reports. It must independently reconcile their rowCount, eligibleCount, and totalCents sums and concatenate/sort excludedIds; use stage F, unavailableSources [], and auditPassed false. It must not reread raw sources.
G: give this child the collected A-D reports, F report, and E report. It must independently audit F against A-D and preserve E's unavailableSources. Its stage G report carries F's verified counts, total and exclusions, E's unavailableSources, and auditPassed true only if all reconciliation checks pass. It must not reread raw sources.

Every report uses nonce ${nonce}. After all children finish, write ${ARTIFACT} with exactly this JSON shape: {nonce,shards:[A report,B report,C report,D report],availability:E report,reconciliation:F report,audit:G report}. Finish with a concise summary referencing the artifact and disclosing the unavailable source by name. Do not infer success from accepted launches or leave a child running. If any child fails, retain all available outcomes and report the failure; do not replace the batch.`,
    async evaluate(params: MatrixPerformanceEvaluation) {
      const taskResponseAt = params.taskResponseAt;
      const receipts = params.receipts
        .filter(isRecord)
        .filter((row) => finite(taskResponseAt) && finite(row.at) && row.at <= taskResponseAt);
      const reads = receipts.filter((row) => row.kind === "fanout-read");
      const submissions = receipts.filter((row) => row.kind === "fanout-submit");
      const tasks = (params.taskRecords ?? []).filter(isRecord);
      const launches = params.trace.activities.filter(
        (activity) =>
          activity.name === "sessions_spawn" &&
          !activity.isError &&
          activity.result.status === "accepted",
      );
      const submittedByChildren = STAGES.every((stage, index) => {
        const task = tasks.find((row) => row.label === labels[index]);
        const submission = submissions.find((row) => row.stage === stage);
        return (
          typeof task?.childSessionKey === "string" &&
          submission?.sessionKey === task.childSessionKey &&
          isDeepStrictEqual(submission?.report, reports[index])
        );
      });
      const raw = await fs.readFile(path.join(params.workspace, ARTIFACT), "utf8").catch(() => "");
      return {
        finalArtifact: isDeepStrictEqual(parseJson(raw), expected),
        exactSubmissions: submissions.length === 7 && submittedByChildren,
        collectorLaunches:
          launches.length === 7 &&
          labels.every((label) =>
            launches.some(
              (activity) =>
                activity.input.label === label &&
                activity.input.collect === true &&
                isRecord(activity.input.outputSchema),
            ),
          ),
        completeSourceReads: STAGES.slice(0, 5).every((stage, index) => {
          const task = tasks.find((row) => row.label === labels[index]);
          return (
            typeof task?.childSessionKey === "string" &&
            reads.some((row) => row.stage === stage && row.sessionKey === task.childSessionKey)
          );
        }),
        ...childLifecycleChecks(params.taskRecords ?? [], labels, taskResponseAt),
      };
    },
  };
}

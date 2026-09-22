import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord as record } from "@openclaw/normalization-core/record-coerce";
import { readResponseWithLimit } from "../../src/infra/http-response-body.js";
import type { ManagedRun } from "../../src/process/supervisor/types.js";
import type { CodeModeMatrixCellResult, RunCellParams } from "../code-mode-model-matrix.ts";
import {
  createGatewayMatrixFixture,
  createGatewayMatrixPluginManifest,
  type GatewayMatrixTask,
} from "./code-mode-matrix-gateway-fixtures.ts";

type RecordValue = Record<string, unknown>;
type ToolCall = { id: string; name: string; args: RecordValue; eventIndex: number };
type ToolOutcome = {
  id: string;
  name: string;
  details: RecordValue;
  content: unknown;
  isError: boolean;
  eventIndex: number;
};
type ToolActivity = {
  name: string;
  input: RecordValue;
  result: RecordValue;
  isError: boolean;
  parentId?: string;
};

const EXEC_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 16_384;
const MAX_MODEL_OUTPUT_TOKENS = 4_000;

export type GatewayMatrixTrace = {
  calls: ToolCall[];
  outcomes: ToolOutcome[];
  activities: ToolActivity[];
  assistantTurns: number;
  models: string[];
  usage?: {
    input: number;
    output: number;
    total?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  costUsd?: number;
};

export type GatewayMatrixWorkload = {
  promptSha256: string;
  fixtureSha256: string;
  settings: {
    thinking: string;
    timeoutSeconds: number;
    execTimeoutMs: number;
    maxOutputBytes: number;
    maxModelOutputTokens: number;
    allowedTools: readonly string[];
  };
};

export type GatewayMatrixEvidence = GatewayMatrixWorkload & {
  behavior: Record<string, boolean>;
  taskElapsedMs?: number;
  startupMs: number;
  traceAvailable: boolean;
  upstreamCalls?: number;
  outerCalls?: number;
  checkedCells?: number;
  outerOutputBytes?: number;
  taskAssistantTurns?: number;
  interview: {
    elapsedMs?: number;
    traceAvailable: boolean;
    answer: unknown;
    rationaleReview: "required";
    checks: Record<string, boolean>;
    trace?: GatewayMatrixTrace;
  };
  artifacts: {
    taskTrace: string;
    interviewTrace: string;
    receipts: string;
    taskReceipts: string;
    interviewReceipts: string;
    log: string;
  };
};

type BehaviorChecks = Record<string, boolean> & { answer: boolean; actualCodeMode: boolean };

/** Workload identity exists before launch, including when a cell cannot start. */
export function createGatewayMatrixWorkload(
  task: GatewayMatrixTask,
  repetition: number,
  thinking: string,
  timeoutSeconds: number,
): GatewayMatrixWorkload {
  const fixture = createGatewayMatrixFixture(task, repetition);
  return {
    promptSha256: createHash("sha256")
      .update(fixture.prompt)
      .update("\0")
      .update(fixture.interviewPrompt)
      .digest("hex"),
    fixtureSha256: createHash("sha256")
      .update(fixture.pluginSource)
      .update(JSON.stringify(fixture.expected))
      .update(JSON.stringify(createGatewayMatrixPluginManifest(fixture.requiredTools)))
      .update(fixture.processHelperSource ?? "")
      .digest("hex"),
    settings: {
      thinking,
      timeoutSeconds,
      execTimeoutMs: EXEC_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxModelOutputTokens: MAX_MODEL_OUTPUT_TOKENS,
      allowedTools: gatewayAllowedTools(task, fixture.requiredTools),
    },
  };
}

function gatewayAllowedTools(
  task: GatewayMatrixTask,
  fixtureTools: readonly string[],
): readonly string[] {
  if (task === "automation-contracts") {
    return ["automations"];
  }
  if (task === "process-contracts") {
    return ["exec", "process"];
  }
  if (task === "checked-cell-cache") {
    return ["process"];
  }
  return fixtureTools;
}

function records(value: unknown): RecordValue[] {
  if (Array.isArray(value)) {
    return value.flatMap(records);
  }
  return record(value) ? [value, ...Object.values(value).flatMap(records)] : [];
}

function outputDetails(message: RecordValue): RecordValue {
  if (record(message.details) && message.details.persistedDetailsTruncated !== true) {
    return message.details;
  }
  for (const item of Array.isArray(message.content) ? message.content : []) {
    if (!record(item) || typeof item.text !== "string") {
      continue;
    }
    try {
      const decoded: unknown = JSON.parse(item.text);
      if (record(decoded)) {
        return decoded;
      }
    } catch {
      /* A truncated display is evidence of truncation, not a complete result. */
    }
  }
  return record(message.details) ? message.details : {};
}

/** Only actual assistant calls and persisted terminal activity count as execution. */
export function collectGatewayMatrixTrace(events: readonly unknown[]): GatewayMatrixTrace {
  const calls: ToolCall[] = [];
  const outcomes: ToolOutcome[] = [];
  const activities: ToolActivity[] = [];
  const models = new Set<string>();
  let assistantTurns = 0;
  let usageSamples = 0;
  let costSamples = 0;
  let totalSamples = 0;
  let cacheReadSamples = 0;
  let cacheWriteSamples = 0;
  let input = 0;
  let output = 0;
  let total = 0;
  let costUsd = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const [eventIndex, event] of events.entries()) {
    if (!record(event)) {
      continue;
    }
    const message = record(event.message) ? event.message : event;
    if (message.role === "assistant") {
      assistantTurns += 1;
      if (typeof message.provider === "string" && typeof message.model === "string") {
        models.add(`${message.provider}/${message.model}`);
      }
      const usage = record(message.usage) ? message.usage : {};
      const inputTokens = asFiniteNumber(usage.input);
      const outputTokens = asFiniteNumber(usage.output);
      if (inputTokens !== undefined && outputTokens !== undefined) {
        usageSamples += 1;
        input += inputTokens;
        output += outputTokens;
        const totalTokens = asFiniteNumber(usage.totalTokens);
        if (totalTokens !== undefined) {
          totalSamples += 1;
          total += totalTokens;
        }
        const readTokens = asFiniteNumber(usage.cacheRead);
        if (readTokens !== undefined) {
          cacheReadSamples += 1;
          cacheRead += readTokens;
        }
        const writeTokens = asFiniteNumber(usage.cacheWrite);
        if (writeTokens !== undefined) {
          cacheWriteSamples += 1;
          cacheWrite += writeTokens;
        }
        const cost = record(usage.cost) ? asFiniteNumber(usage.cost.total) : undefined;
        if (cost !== undefined) {
          costSamples += 1;
          costUsd += cost;
        }
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (
          record(block) &&
          block.type === "toolCall" &&
          typeof block.id === "string" &&
          typeof block.name === "string"
        ) {
          calls.push({
            id: block.id,
            name: block.name,
            args: record(block.arguments) ? block.arguments : {},
            eventIndex,
          });
        }
      }
    } else if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      outcomes.push({
        id: message.toolCallId,
        name: typeof message.toolName === "string" ? message.toolName : "",
        details: outputDetails(message),
        content: message.content,
        isError: message.isError === true,
        eventIndex,
      });
    } else if (message.customType === "openclaw.nested-tool.v1" && record(message.details)) {
      const data = message.details;
      if (typeof data.toolName !== "string") {
        continue;
      }
      const result = record(data.result) && record(data.result.details) ? data.result.details : {};
      activities.push({
        name: data.toolName,
        input: record(data.input) ? data.input : {},
        result,
        isError: data.isError === true,
        ...(typeof data.parentToolCallId === "string" ? { parentId: data.parentToolCallId } : {}),
      });
    }
  }
  return {
    calls,
    outcomes,
    activities,
    assistantTurns,
    models: [...models],
    ...(usageSamples === assistantTurns && assistantTurns > 0
      ? {
          usage: {
            input,
            output,
            ...(totalSamples === assistantTurns ? { total } : {}),
            ...(cacheReadSamples === assistantTurns ? { cacheRead } : {}),
            ...(cacheWriteSamples === assistantTurns ? { cacheWrite } : {}),
          },
        }
      : {}),
    ...(costSamples === assistantTurns && assistantTurns > 0 ? { costUsd } : {}),
  };
}

function jsonAnswer(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    return undefined;
  }
}

function settledCallOutcome(trace: GatewayMatrixTrace, call: ToolCall): ToolOutcome | undefined {
  let outcome = trace.outcomes.findLast((item) => item.id === call.id);
  let cursor = trace.calls.indexOf(call);
  while (outcome && !outcome.isError && outcome.details.status === "waiting") {
    const runId = outcome.details.runId;
    if (typeof runId !== "string") {
      return undefined;
    }
    const next = trace.calls.findIndex(
      (item, index) => index > cursor && item.name === "wait" && item.args.runId === runId,
    );
    const wait = trace.calls[next];
    if (!wait) {
      return undefined;
    }
    cursor = next;
    outcome = trace.outcomes.findLast((item) => item.id === wait.id);
  }
  return outcome && ["completed", "failed"].includes(String(outcome.details.status))
    ? outcome
    : undefined;
}

function completedCallOutcome(trace: GatewayMatrixTrace, call: ToolCall): ToolOutcome | undefined {
  const outcome = settledCallOutcome(trace, call);
  return outcome && !outcome.isError && outcome.details.status === "completed"
    ? outcome
    : undefined;
}

function source(call: ToolCall): string {
  return typeof call.args.code === "string"
    ? call.args.code
    : typeof call.args.command === "string"
      ? call.args.command
      : "";
}

function observedReferences(
  trace: GatewayMatrixTrace,
): { id: string; previewComplete: boolean | null }[] {
  return trace.outcomes.flatMap((outcome) =>
    records(outcome.details).flatMap((item) =>
      typeof item.id === "string" &&
      typeof item.bytes === "number" &&
      typeof item.preview === "string"
        ? [
            {
              id: item.id,
              previewComplete:
                typeof item.previewTruncated === "boolean" ? !item.previewTruncated : null,
            },
          ]
        : [],
    ),
  );
}

function referenceIds(trace: GatewayMatrixTrace): string[] {
  return [...new Set(observedReferences(trace).map((reference) => reference.id))];
}

export function evaluateGatewayMatrixTask(params: {
  task: GatewayMatrixTask;
  expected: RecordValue;
  final: string;
  trace: GatewayMatrixTrace;
  receipts: readonly unknown[];
}): BehaviorChecks {
  const { task, trace, expected } = params;
  const receiptRows = params.receipts.filter(record);
  const receiptCalls = receiptRows.filter((row) => row.kind === "call");
  const checked = trace.calls.filter(
    (call) =>
      call.name === "exec" &&
      call.args.language === "typescript" &&
      call.args.typecheck === true &&
      completedCallOutcome(trace, call) !== undefined,
  );
  const checkedInvocation = (item: ToolActivity) =>
    trace.calls.some(
      (call) =>
        call.id === item.parentId &&
        call.name === "exec" &&
        call.args.language === "typescript" &&
        call.args.typecheck === true,
    );
  const activity = trace.activities.filter((item) => !item.isError);
  const checks: BehaviorChecks = {
    answer: isDeepStrictEqual(jsonAnswer(params.final), expected),
    actualCodeMode:
      trace.calls.some((call) => call.name === "exec") &&
      trace.outcomes.some((outcome) =>
        ["completed", "waiting", "failed"].includes(String(outcome.details.status)),
      ),
  };
  if (task === "invoices-auto-retention") {
    const firstFetch = trace.activities.find((item) => item.name === "matrix_invoice_export");
    const fetchCell = trace.calls.find((call) => call.id === firstFetch?.parentId);
    const fetched = fetchCell ? completedCallOutcome(trace, fetchCell) : undefined;
    const automatic =
      fetched &&
      record(fetched.details.value) &&
      fetched.details.value.truncated === true &&
      record(fetched.details.value.reference)
        ? fetched
        : undefined;
    const refs = automatic ? referenceIds({ ...trace, outcomes: [automatic] }) : [];
    const load = trace.calls.find(
      (call) =>
        refs.some((id) => source(call).includes(id)) && source(call).includes("results.load"),
    );
    const outer = JSON.stringify(trace.outcomes.map((outcome) => outcome.content));
    checks.automaticReference =
      refs.length > 0 && fetchCell !== undefined && !source(fetchCell).includes("results.save");
    checks.laterCellReusesReference =
      load !== undefined &&
      fetchCell !== undefined &&
      trace.calls.indexOf(load) > trace.calls.indexOf(fetchCell) &&
      completedCallOutcome(trace, load) !== undefined;
    checks.singleFetch =
      receiptCalls.filter((row) => row.tool === "matrix_invoice_export").length === 1;
    checks.boundedModelData = new Set(outer.match(/INV-\d+-\d+/gu) ?? []).size <= 8;
    checks.noPastedRecords = trace.calls
      .filter((call) => call.id !== fetchCell?.id)
      .every((call) => !/INV-\d+-\d+/u.test(source(call)));
  } else if (task === "inventory-join") {
    checks.completeSources = ["matrix_inventory_export", "matrix_supplier_directory"].every(
      (name) => receiptCalls.some((row) => row.tool === name),
    );
  } else if (task === "automation-contracts") {
    const automations = activity.filter((item) => item.name === "automations");
    const completeInventory = (item: ToolActivity) =>
      item.input.action === "list" &&
      item.input.includeDisabled === true &&
      item.result.hasMore === false &&
      item.result.nextOffset === null &&
      Array.isArray(item.result.jobs) &&
      item.result.jobs.length === item.result.total;
    const mutation = (item: ToolActivity) =>
      ["add", "update", "remove"].includes(String(item.input.action));
    const firstMutation = automations.findIndex(mutation);
    const lastMutation = automations.findLastIndex(mutation);
    const initialInventory = automations.find(
      (item, index) => index < firstMutation && completeInventory(item),
    );
    const terminalInventory = automations.findLast(
      (item, index) => index > lastMutation && completeInventory(item),
    );
    const created = automations.filter((item) => item.input.action === "add");
    const initialJobs = Array.isArray(initialInventory?.result.jobs)
      ? initialInventory.result.jobs.filter(record)
      : undefined;
    const finalJobs = Array.isArray(terminalInventory?.result.jobs)
      ? terminalInventory.result.jobs.filter(record)
      : [];
    const jobId = (item: ToolActivity) =>
      record(item.result.job) ? item.result.job.id : item.result.id;
    checks.actionContracts =
      ["add", "get", "list", "update", "runs", "remove"].every((action) =>
        automations.some((item) => item.input.action === action),
      ) &&
      automations.some((item, index) => index < firstMutation && item.input.action === "status");
    checks.checkedComposition = automations.length > 0 && automations.every(checkedInvocation);
    checks.createdDisabled =
      created.length > 0 &&
      created.every(
        (item) =>
          record(item.input.job) &&
          item.input.job.enabled === false &&
          (record(item.result.job) ? item.result.job.enabled : item.result.enabled) === false,
      );
    checks.remainedDisabled = trace.activities
      .filter((item) => item.name === "automations")
      .every((item) => {
        if (["run", "wake"].includes(String(item.input.action))) {
          return false;
        }
        if (item.input.action !== "update") {
          return true;
        }
        if (
          item.input.enabled === true ||
          (record(item.input.job) && item.input.job.enabled === true) ||
          (record(item.input.patch) && item.input.patch.enabled === true)
        ) {
          return false;
        }
        const job = record(item.result.job) ? item.result.job : item.result;
        return item.isError || job.enabled === false;
      });
    const createdIds = new Set(created.map(jobId));
    checks.onlyOwnedMutations = trace.activities
      .filter(
        (item) =>
          item.name === "automations" && ["update", "remove"].includes(String(item.input.action)),
      )
      .every((item) => createdIds.has(item.input.jobId ?? item.input.id));
    checks.createdFacts =
      created.length === 1 &&
      trace.activities.filter((item) => item.name === "automations" && item.input.action === "add")
        .length === 1 &&
      created.every((item) => {
        const job = record(item.result.job) ? item.result.job : item.result;
        const scheduledAt =
          record(job.schedule) && job.schedule.kind === "at" && typeof job.schedule.at === "string"
            ? Date.parse(job.schedule.at)
            : Number.NaN;
        const createdAt = asFiniteNumber(job.createdAtMs);
        return (
          job.name === expected.jobName &&
          job.sessionTarget === "main" &&
          record(job.payload) &&
          job.payload.kind === "systemEvent" &&
          job.payload.text === expected.payloadText &&
          createdAt !== undefined &&
          Number.isFinite(scheduledAt) &&
          Math.abs(scheduledAt - createdAt - 86_400_000) <= 300_000
        );
      });
    const createdJob = created[0];
    const createdId = createdJob && jobId(createdJob);
    const createdIndex = createdJob ? automations.indexOf(createdJob) : -1;
    const lifecycleStep = (action: string, after: number, name?: unknown) =>
      automations.findIndex(
        (item, index) =>
          index > after &&
          item.input.action === action &&
          (item.input.jobId ?? item.input.id) === createdId &&
          (name === undefined ||
            (jobId(item) === createdId &&
              (record(item.result.job) ? item.result.job.name : item.result.name) === name)),
      );
    const initialRead = lifecycleStep("get", createdIndex, expected.jobName);
    const update = lifecycleStep("update", initialRead, expected.updatedName);
    const updatedRead = lifecycleStep("get", update, expected.updatedName);
    const history = lifecycleStep("runs", createdIndex);
    const remove = lifecycleStep("remove", Math.max(updatedRead, history));
    checks.createdLifecycleObserved =
      typeof createdId === "string" &&
      [initialRead, update, updatedRead, history, remove].every((index) => index >= 0);
    checks.terminalInventoryComplete = terminalInventory !== undefined;
    checks.createdRemoved =
      terminalInventory !== undefined &&
      created.every(
        (item) =>
          typeof jobId(item) === "string" && !finalJobs.some((job) => job.id === jobId(item)),
      );
    checks.baselinePreserved =
      initialJobs !== undefined &&
      terminalInventory !== undefined &&
      isDeepStrictEqual(
        initialJobs.toSorted((a, b) => String(a.id).localeCompare(String(b.id))),
        finalJobs.toSorted((a, b) => String(a.id).localeCompare(String(b.id))),
      );
  } else if (task === "process-contracts") {
    const processes = activity.filter((item) => item.name === "process");
    const launches = trace.activities.filter((item) => item.name === "exec");
    const helperSessionIds = new Set(
      activity.flatMap((item) =>
        item.name === "exec" &&
        typeof item.input.command === "string" &&
        item.input.command.includes("process-probe.mjs") &&
        typeof item.result.sessionId === "string"
          ? [item.result.sessionId]
          : [],
      ),
    );
    const helperOperations = processes.filter((item) =>
      helperSessionIds.has(String(item.input.sessionId)),
    );
    checks.realProcessControl =
      processes.some((item) => item.input.action === "list") &&
      processes.some((item) => item.input.action === "poll" || item.input.action === "log");
    checks.singleHelperLaunch =
      launches.length === 1 &&
      launches.every(
        (item) =>
          !item.isError &&
          typeof item.input.command === "string" &&
          item.input.command.trim() === "node ./process-probe.mjs" &&
          item.input.background === true &&
          typeof item.result.sessionId === "string",
      );
    checks.onlyHelperReads = trace.activities
      .filter((item) => item.name === "process")
      .every(
        (item) =>
          item.input.action === "list" ||
          (["log", "poll"].includes(String(item.input.action)) &&
            helperSessionIds.has(String(item.input.sessionId))),
      );
    checks.checkedComposition =
      processes.length > 0 && [...launches, ...processes].every(checkedInvocation);
    checks.observedCompletion = helperOperations.some(
      (item) => item.result.status === "completed" && item.result.exitCode === 0,
    );
    checks.observedMarker =
      typeof expected.marker === "string" &&
      helperOperations.some((item) =>
        JSON.stringify(item.result).includes(String(expected.marker)),
      );
  } else if (task === "partial-failure") {
    const mutations = receiptRows.filter((row) => row.kind === "effect");
    const failedCall = trace.activities.find(
      (item) => item.name === "matrix_settle" && item.isError,
    );
    const settleAt = receiptCalls.findIndex((row) => row.tool === "matrix_settle");
    const inspectAt = receiptCalls.findIndex(
      (row, index) => index > settleAt && row.tool === "matrix_settlement_inspect",
    );
    checks.exactlyOneEffect =
      mutations.length === 1 &&
      receiptCalls.filter((row) => row.tool === "matrix_settle").length === 1 &&
      mutations[0]?.operationId === expected.operationId &&
      mutations[0]?.totalCents === expected.totalCents;
    checks.inspectedAfterFailure =
      failedCall !== undefined && inspectAt > settleAt && settleAt >= 0;
    checks.observedPersistedState = activity.some(
      (item) =>
        item.name === "matrix_settlement_inspect" && isDeepStrictEqual(item.result, expected),
    );
    const settlementCell = trace.calls.find((call) => call.id === failedCall?.parentId);
    const settlementOutcome = settlementCell
      ? settledCallOutcome(trace, settlementCell)
      : undefined;
    const failureText = JSON.stringify({
      nested: trace.activities.filter((item) => item.name === "matrix_settle" && item.isError),
      recovery: trace.outcomes.filter(
        (outcome) =>
          outcome.id === failedCall?.parentId ||
          outcome.id === settlementOutcome?.id ||
          outcome.isError ||
          outcome.details.status === "failed",
      ),
    });
    checks.actionableDiagnostics =
      failureText.includes("receipt") && failureText.includes("totalCents");
  } else {
    checks.threeCheckedCells =
      checked.length === 3 && trace.calls.filter((call) => call.name === "exec").length === 3;
    checks.sequentialCells = checked.every((call, index) => {
      const previous = checked[index - 1];
      return (
        previous === undefined ||
        (completedCallOutcome(trace, previous)?.eventIndex ?? Infinity) < call.eventIndex
      );
    });
    checks.onlyProcessListReads = trace.activities.every(
      (item) => item.name === "process" && item.input.action === "list",
    );
    checks.processListPerCell = checked.every((call) =>
      activity.some(
        (item) =>
          item.parentId === call.id && item.name === "process" && item.input.action === "list",
      ),
    );
    const expectedCells = expected.cells;
    checks.returnedCellValues =
      Array.isArray(expectedCells) &&
      checked.length === expectedCells.length &&
      checked.every((call, index) =>
        isDeepStrictEqual(completedCallOutcome(trace, call)?.details.value, expectedCells[index]),
      );
  }
  return checks;
}

/** Claims support the interview; an attempted expired read also needs observed runtime evidence. */
export function evaluateGatewayMatrixInterview(
  task: GatewayMatrixTask,
  taskTrace: GatewayMatrixTrace,
  interviewTrace: GatewayMatrixTrace,
  final: string,
): Record<string, boolean> {
  const references = observedReferences(taskTrace);
  const priorRefs = [...new Set(references.map((reference) => reference.id))];
  const attempts = interviewTrace.calls.filter(
    (call) =>
      source(call).includes("results.load") && priorRefs.some((id) => source(call).includes(id)),
  );
  const unavailable = attempts.some((call) => {
    const outcome = settledCallOutcome(interviewTrace, call);
    return outcome !== undefined && /unavailable|expired/iu.test(JSON.stringify(outcome.details));
  });
  const previewCoverage = new Set(
    references
      .filter((reference) => attempts.some((call) => source(call).includes(reference.id)))
      .map((reference) => reference.previewComplete),
  );
  const previewComplete = previewCoverage.size === 1 ? [...previewCoverage][0] : null;
  const answer = jsonAnswer(final);
  const facts = record(answer) && record(answer.facts) ? answer.facts : {};
  return {
    answered:
      record(answer) && typeof answer.rationale === "string" && answer.rationale.trim().length > 0,
    noExternalAction: interviewTrace.activities.length === 0,
    priorReferenceProbed: priorRefs.length === 0 || attempts.length > 0,
    priorReferenceUnavailable:
      priorRefs.length === 0 || (unavailable && facts.priorRefAvailable === false),
    retainedSnapshotUnderstood:
      priorRefs.length === 0 ||
      (facts.retainedDataFresh === false &&
        facts.sameRunOnly === true &&
        facts.previewComplete === previewComplete),
    noRollbackAssumption: task !== "partial-failure" || facts.failureImpliesRollback === false,
  };
}

export function requireGatewayMatrixTools(catalog: unknown, required: readonly string[]): string[] {
  const available = new Set(
    records(catalog).flatMap((item) =>
      typeof item.id === "string" &&
      (item.source === "core" ||
        (item.source === "plugin" && item.pluginId === "code-mode-matrix-fixture"))
        ? [item.id]
        : [],
    ),
  );
  const missing = required.filter((name) => !available.has(name));
  if (missing.length > 0) {
    throw new Error(`Fixture capability preflight failed before model call: ${missing.join(", ")}`);
  }
  return [...required];
}

async function availablePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve loopback port"));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitReady(child: ManagedRun, port: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    if (child.activity.resultSettled) {
      throw new Error("Owned benchmark Gateway exited during startup");
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        return;
      }
    } catch {
      /* Readiness is the observed startup condition. */
    }
    await delay(250);
  }
  throw new Error("Owned benchmark Gateway did not become ready within 90 seconds");
}

type ResponseResult = { id?: string; status?: string; final: string; error?: string };

async function agentRequest(
  port: number,
  token: string,
  prompt: string,
  timeoutSeconds: number,
  previousId?: string,
  abortSignal?: AbortSignal,
): Promise<ResponseResult> {
  const url = `http://127.0.0.1:${port}/v1/responses`;
  const timeout = AbortSignal.timeout(timeoutSeconds * 1_000);
  const signal = abortSignal ? AbortSignal.any([timeout, abortSignal]) : timeout;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "x-openclaw-agent-id": "qa",
      "x-openclaw-scopes": "operator.admin,operator.read,operator.write",
    },
    body: JSON.stringify({
      model: "openclaw/qa",
      input: prompt,
      ...(previousId ? { previous_response_id: previousId } : {}),
      max_output_tokens: MAX_MODEL_OUTPUT_TOKENS,
      stream: false,
    }),
    signal,
  });
  const bytes = await readResponseWithLimit(response, 4 * 1024 * 1024, {
    signal,
    onOverflow: ({ maxBytes }) => new Error(`${url} response body exceeded ${maxBytes} bytes`),
  });
  const text = new TextDecoder().decode(bytes);
  if (!response.ok) {
    throw new Error(`Gateway HTTP ${response.status}: ${text.slice(0, 2_000)}`);
  }
  const value: unknown = JSON.parse(text);
  if (!record(value)) {
    throw new Error("Gateway returned an invalid response envelope");
  }
  const final = (Array.isArray(value.output) ? value.output : [])
    .flatMap((item) =>
      record(item) && item.type === "message" && Array.isArray(item.content)
        ? item.content.flatMap((part) =>
            record(part) && part.type === "output_text" && typeof part.text === "string"
              ? [part.text]
              : [],
          )
        : [],
    )
    .join("\n");
  return {
    ...(typeof value.id === "string" ? { id: value.id } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    final,
    ...(record(value.error) && typeof value.error.message === "string"
      ? { error: value.error.message }
      : {}),
  };
}

function transcriptRows(stateDir: string): { seq: number; event: unknown }[] {
  const db = new DatabaseSync(
    path.join(stateDir, "agents", "qa", "agent", "openclaw-agent.sqlite"),
    { readOnly: true },
  );
  try {
    return db
      .prepare("SELECT seq,event_json FROM transcript_events ORDER BY session_id,seq")
      .all()
      .map((row) => ({ seq: Number(row.seq), event: JSON.parse(String(row.event_json)) }));
  } finally {
    db.close();
  }
}

/** Run actual tool contracts and a separate interview through a disposable built Gateway. */
export async function runGatewayMatrixCell(
  params: RunCellParams & { cell: RunCellParams["cell"] & { task: GatewayMatrixTask } },
): Promise<CodeModeMatrixCellResult> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("OPENAI_API_KEY is required for Gateway interview tasks");
  }
  if (!params.runtime) {
    throw new Error("Built runtime entrypoint was not prepared");
  }
  const fixture = createGatewayMatrixFixture(params.cell.task, params.cell.repetition);
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-interview-")),
  );
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const pluginDir = path.join(root, "fixture");
  const receiptsPath = path.join(root, "receipts.jsonl");
  const readReceipts = async (): Promise<unknown[]> =>
    (await fs.readFile(receiptsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  const artifactDir = path.join(params.outputDir, "cells", params.cell.id);
  const token = `synthetic-matrix-${randomUUID()}`;
  const redact = (value: string) =>
    value.replaceAll(key, "[REDACTED]").replaceAll(token, "[SYNTHETIC_GATEWAY_TOKEN]");
  const write = async (name: string, value: unknown) =>
    fs.writeFile(path.join(artifactDir, name), redact(`${JSON.stringify(value, null, 2)}\n`), {
      mode: 0o600,
    });
  await Promise.all(
    [
      stateDir,
      workspace,
      pluginDir,
      path.join(root, "home"),
      path.join(root, "tmp"),
      artifactDir,
    ].map((directory) => fs.mkdir(directory, { recursive: true })),
  );
  await fs.writeFile(path.join(pluginDir, "index.mjs"), fixture.pluginSource);
  await fs.writeFile(receiptsPath, "", { mode: 0o600 });
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify(createGatewayMatrixPluginManifest(fixture.requiredTools)),
  );
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "code-mode-matrix-fixture",
      version: "1.0.0",
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  if (fixture.processHelperSource !== undefined) {
    await fs.writeFile(path.join(workspace, "process-probe.mjs"), fixture.processHelperSource);
  }
  const port = await availablePort();
  const configPath = path.join(stateDir, "openclaw.json");
  const cfg = {
    logging: { level: "warn", consoleLevel: "warn", file: path.join(root, "gateway.log") },
    env: { shellEnv: { enabled: false } },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        thinkingDefault: params.thinking,
        heartbeat: { every: "0m" },
        model: { primary: params.cell.model },
        models: { [params.cell.model]: { agentRuntime: { id: "openclaw" } } },
        systemAgent: { agentId: "qa" },
      },
      entries: { qa: {} },
    },
    plugins: {
      allow: ["openai", ...(fixture.requiredTools.length > 0 ? ["code-mode-matrix-fixture"] : [])],
      slots: { memory: "none" },
      ...(fixture.requiredTools.length > 0 ? { load: { paths: [pluginDir] } } : {}),
      entries: {
        openai: { enabled: true },
        ...(fixture.requiredTools.length > 0
          ? { "code-mode-matrix-fixture": { enabled: true, config: { receiptsPath } } }
          : {}),
      },
    },
    memory: { search: { enabled: false } },
    skills: { load: { watch: false } },
    discovery: { mdns: { mode: "off" } },
    tools: {
      profile: "full",
      allow: gatewayAllowedTools(params.cell.task, fixture.requiredTools),
      fs: { workspaceOnly: true },
      exec: { security: "full", ask: "off" },
      codeMode: { enabled: true, timeoutMs: EXEC_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES },
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
      http: { endpoints: { responses: { enabled: true } } },
    },
  };
  await fs.writeFile(configPath, JSON.stringify(cfg), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    OPENAI_API_KEY: key,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_ACPX_RUNTIME: "1",
    OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
  const startedAt = Date.now();
  const { createProcessSupervisor } = await import("../../src/process/supervisor/supervisor.js");
  const supervisor = createProcessSupervisor();
  const scopeKey = `code-mode-matrix:${randomUUID()}`;
  const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  let child: ManagedRun | undefined;
  let log = "";
  let failure: unknown;
  let task: ResponseResult = { final: "" };
  let interview: ResponseResult = { final: "" };
  let taskEvents: unknown[] = [];
  let interviewEvents: unknown[] = [];
  let startupMs = 0;
  let taskElapsedMs: number | undefined;
  let interviewElapsedMs: number | undefined;
  let taskTraceAvailable = false;
  let interviewTraceAvailable = false;
  let receipts: unknown[];
  let taskReceipts: unknown[] | undefined;
  let taskStartedAt: number | undefined;
  let interviewStartedAt: number | undefined;
  let interviewBoundary: number | undefined;
  try {
    const capture = (chunk: string) => {
      log = `${log}${chunk}`.slice(-64 * 1024);
    };
    child = await supervisor.spawn({
      mode: "child",
      scopeKey,
      argv: [
        process.execPath,
        ...params.runtime.args,
        "gateway",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      cwd: workspace,
      env,
      exactEnv: true,
      stdinMode: "pipe-closed",
      timeoutMs: (params.timeoutSeconds * 2 + 120) * 1_000,
      captureOutput: false,
      onStdout: capture,
      onStderr: capture,
    });
    await waitReady(child, port, params.abortSignal);
    const { runCommandWithTimeout } = await import("../../src/process/exec.js");
    const catalogCommand = await runCommandWithTimeout(
      [
        process.execPath,
        ...params.runtime.args,
        "gateway",
        "call",
        "tools.catalog",
        "--params",
        JSON.stringify({ agentId: "qa", includePlugins: true }),
        "--url",
        `ws://127.0.0.1:${port}`,
        "--token",
        token,
        "--timeout",
        "30000",
        "--json",
      ],
      {
        cwd: workspace,
        baseEnv: {},
        env,
        input: "",
        timeoutMs: 40_000,
        signal: params.abortSignal,
        maxOutputBytes: 1024 * 1024,
        killProcessTree: true,
        requireProcessTreeExtinction: true,
      },
    );
    if (catalogCommand.code !== 0 || catalogCommand.cleanup === "uncertain") {
      throw new Error(
        `Fixture catalog preflight failed before model call: ${redact(catalogCommand.stderr).slice(-2_000) || catalogCommand.cleanup || catalogCommand.code}`,
      );
    }
    const catalog: unknown = JSON.parse(catalogCommand.stdout);
    requireGatewayMatrixTools(
      catalog,
      gatewayAllowedTools(params.cell.task, fixture.requiredTools),
    );
    await write("tool-catalog.json", catalog);
    startupMs = Date.now() - startedAt;
    taskStartedAt = Date.now();
    try {
      task = await agentRequest(
        port,
        token,
        fixture.prompt,
        params.timeoutSeconds,
        undefined,
        params.abortSignal,
      );
    } finally {
      taskElapsedMs = Date.now() - taskStartedAt;
    }
    const rows = transcriptRows(stateDir);
    taskTraceAvailable = true;
    taskEvents = rows.map((row) => row.event);
    interviewBoundary = Math.max(0, ...rows.map((row) => row.seq));
    taskReceipts = await readReceipts();
    if (!task.id) {
      throw new Error("Task response lacks continuity id for the interview");
    }
    interviewStartedAt = Date.now();
    try {
      interview = await agentRequest(
        port,
        token,
        fixture.interviewPrompt,
        params.timeoutSeconds,
        task.id,
        params.abortSignal,
      );
    } finally {
      interviewElapsedMs = Date.now() - interviewStartedAt;
    }
  } catch (error) {
    failure = error;
  } finally {
    if (taskStartedAt === undefined) {
      startupMs = Date.now() - startedAt;
    }
    child?.cancel("manual-cancel");
    for (const settle of [() => child?.wait(), cleanup, () => supervisor.shutdown()]) {
      try {
        await settle();
      } catch (error) {
        failure ??= error;
      }
    }
    if (taskStartedAt !== undefined) {
      try {
        const rows = transcriptRows(stateDir);
        taskTraceAvailable = true;
        interviewTraceAvailable = interviewStartedAt !== undefined;
        const boundary = interviewBoundary;
        taskEvents = rows
          .filter((row) => boundary === undefined || row.seq <= boundary)
          .map((row) => row.event);
        interviewEvents =
          boundary === undefined
            ? []
            : rows.filter((row) => row.seq > boundary).map((row) => row.event);
      } catch (error) {
        failure ??= error;
      }
    }
    receipts = [];
    try {
      receipts = await readReceipts();
    } catch (error) {
      failure ??= error;
    }
    taskReceipts ??= receipts;
    await write("task-transcript.json", taskEvents);
    await write("interview-transcript.json", interviewEvents);
    await write("receipts.json", receipts);
    await write("task-receipts.json", taskReceipts);
    await write("interview-receipts.json", receipts.slice(taskReceipts.length));
    await fs.writeFile(path.join(artifactDir, "gateway.log"), redact(log), { mode: 0o600 });
  }
  const trace = collectGatewayMatrixTrace(taskEvents);
  const interviewTrace = collectGatewayMatrixTrace(interviewEvents);
  const behavior = evaluateGatewayMatrixTask({
    task: params.cell.task,
    expected: fixture.expected,
    final: task.final,
    trace,
    receipts: taskReceipts,
  });
  const interviewChecks = evaluateGatewayMatrixInterview(
    params.cell.task,
    trace,
    interviewTrace,
    interview.final,
  );
  const identity =
    trace.models.length > 0 &&
    trace.models.every((model) => model === params.cell.model) &&
    interviewTrace.models.length > 0 &&
    interviewTrace.models.every((model) => model === params.cell.model);
  const passed =
    !failure &&
    task.status === "completed" &&
    interview.status === "completed" &&
    identity &&
    Object.values(behavior).every(Boolean) &&
    Object.values(interviewChecks).every(Boolean);
  const error =
    failure instanceof Error ? redact(failure.message) : (task.error ?? interview.error);
  const outerOutput = JSON.stringify(trace.outcomes.map((outcome) => outcome.content));
  const gateway: GatewayMatrixEvidence = {
    ...createGatewayMatrixWorkload(
      params.cell.task,
      params.cell.repetition,
      params.thinking,
      params.timeoutSeconds,
    ),
    behavior,
    ...(taskElapsedMs !== undefined ? { taskElapsedMs } : {}),
    startupMs,
    traceAvailable: taskTraceAvailable,
    ...(taskTraceAvailable
      ? {
          upstreamCalls: trace.activities.length,
          outerCalls: trace.calls.length,
          checkedCells: trace.calls.filter(
            (call) =>
              call.args.typecheck === true && completedCallOutcome(trace, call) !== undefined,
          ).length,
          outerOutputBytes: Buffer.byteLength(outerOutput),
          taskAssistantTurns: trace.assistantTurns,
        }
      : {}),
    interview: {
      ...(interviewElapsedMs !== undefined ? { elapsedMs: interviewElapsedMs } : {}),
      traceAvailable: interviewTraceAvailable,
      answer: jsonAnswer(interview.final) ?? interview.final,
      rationaleReview: "required",
      checks: interviewChecks,
      ...(interviewTraceAvailable ? { trace: interviewTrace } : {}),
    },
    artifacts: {
      taskTrace: path.relative(params.outputDir, path.join(artifactDir, "task-transcript.json")),
      interviewTrace: path.relative(
        params.outputDir,
        path.join(artifactDir, "interview-transcript.json"),
      ),
      receipts: path.relative(params.outputDir, path.join(artifactDir, "receipts.json")),
      taskReceipts: path.relative(params.outputDir, path.join(artifactDir, "task-receipts.json")),
      interviewReceipts: path.relative(
        params.outputDir,
        path.join(artifactDir, "interview-receipts.json"),
      ),
      log: path.relative(params.outputDir, path.join(artifactDir, "gateway.log")),
    },
  };
  await write("evidence.json", { gateway, task, interview });
  if (params.keepState || failure) {
    await write("retained-state.json", {
      root,
      reason: failure ? "failure inspection" : "requested",
    });
  } else {
    await fs.rm(root, { recursive: true, force: true });
  }
  const slash = params.cell.model.indexOf("/");
  return {
    id: params.cell.id,
    task: params.cell.task,
    model: params.cell.model,
    mode: params.cell.mode,
    repetition: params.cell.repetition,
    gitSha: params.gitSha,
    buildSha256: params.buildSha256,
    sourceDirty: params.sourceDirty,
    sourcePatchSha256: params.sourcePatchSha256,
    timestamp: new Date().toISOString(),
    passed,
    status: error ? "error" : "ok",
    elapsedMs: Date.now() - startedAt,
    expected: JSON.stringify(fixture.expected),
    final: redact(task.final),
    failureCategory: passed
      ? null
      : failure
        ? "harness_error"
        : !identity
          ? "model_mismatch"
          : !behavior.answer
            ? "answer_mismatch"
            : task.status !== "completed" || !Object.values(behavior).every(Boolean)
              ? "tool_execution"
              : "interview_mismatch",
    ...(error
      ? {
          diagnostics: error.slice(0, 8_000),
          error: { kind: "gateway_benchmark", message: error.slice(0, 2_000) },
        }
      : {}),
    codeModeEngaged: taskTraceAvailable ? behavior.actualCodeMode : null,
    observedProvider: identity ? params.cell.model.slice(0, slash) : null,
    observedModel: identity ? params.cell.model.slice(slash + 1) : null,
    ...(taskTraceAvailable ? { assistantTurns: trace.assistantTurns } : {}),
    ...(trace.usage ? { usage: trace.usage } : {}),
    ...(trace.costUsd !== undefined ? { costUsd: trace.costUsd } : {}),
    oracle: {
      answer: behavior.answer,
      effect: Object.values(behavior).every(Boolean),
      engagement: behavior.actualCodeMode,
      identity,
      toolExecution: trace.activities.length > 0,
    },
    gateway,
  };
}

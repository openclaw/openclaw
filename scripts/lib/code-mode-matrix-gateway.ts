import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord as record } from "@openclaw/normalization-core/record-coerce";
import { parse } from "acorn";
import type { CodeModeExecutorId } from "../../src/agents/code-mode-executor-types.js";
import { resolveCodeModeConfig } from "../../src/agents/code-mode-runtime.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { mergeDeep } from "../../src/infra/deep-merge.js";
import { readResponseWithLimit } from "../../src/infra/http-response-body.js";
import type { ManagedRun } from "../../src/process/supervisor/types.js";
import type { CodeModeMatrixCellResult, RunCellParams } from "../code-mode-model-matrix.ts";
import {
  createGatewayMatrixFixture,
  createGatewayMatrixPluginManifest,
  createGatewayMatrixPluginSource,
  type GatewayMatrixTask as GatewayMatrixContractTask,
  type GatewayMatrixFixture,
} from "./code-mode-matrix-gateway-fixtures.ts";
import {
  createMatrixPerformanceFixture,
  isMatrixPerformanceTask,
  type MatrixPerformanceTask,
} from "./code-mode-matrix-performance-fixtures.ts";
import type { MatrixPerformanceFixture } from "./code-mode-matrix-performance-types.ts";
import {
  classifyCodeModeMatrixProviderFailure,
  matrixModelConfig,
  matrixProviderEnv,
} from "./code-mode-matrix-provider.ts";
import {
  readMatrixSessionLedger,
  captureMatrixLedgerBoundary,
  selectMatrixLedgerRows,
  collectMatrixUsage,
  type MatrixLedgerBoundary,
  type MatrixSessionLedger,
  type MatrixUsageAccounting,
} from "./code-mode-matrix-usage.ts";
import { redactForDevToolLog } from "./dev-tooling-safety.ts";

export type GatewayMatrixTask = GatewayMatrixContractTask | MatrixPerformanceTask;

type RecordValue = Record<string, unknown>;
type ToolCall = {
  id: string;
  name: string;
  args: RecordValue;
  eventIndex: number;
  sessionKey?: string;
};
type ToolOutcome = {
  id: string;
  name: string;
  details: RecordValue;
  content: unknown;
  isError: boolean;
  eventIndex: number;
  sessionKey?: string;
};
type ToolActivity = {
  name: string;
  input: RecordValue;
  result: RecordValue;
  content?: unknown;
  isError: boolean;
  parentId?: string;
  sessionKey?: string;
  eventIndex?: number;
};

const SHIPPING_CODE_MODE = resolveCodeModeConfig();
const EXEC_TIMEOUT_MS = SHIPPING_CODE_MODE.timeoutMs;
const MAX_OUTPUT_BYTES = SHIPPING_CODE_MODE.maxOutputBytes;
const MAX_MODEL_OUTPUT_TOKENS = 4_000;
const PERFORMANCE_GRADING_REVISION = "performance-outcome-v4";

export type GatewayMatrixActivationDiagnostic = {
  runId: string;
  active: boolean;
  toolsEnabled: boolean;
  toolsDisabled: boolean;
  rawRun: boolean;
  fallbackActive: boolean;
  allowlist?: string;
};

export function parseGatewayMatrixActivationDiagnostic(
  line: string,
): GatewayMatrixActivationDiagnostic | undefined {
  const marker = "code-mode diagnostic ";
  const start = line.indexOf(marker);
  if (start < 0) {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(line.slice(start + marker.length, line.lastIndexOf("}") + 1));
    if (
      !record(value) ||
      value.boundary !== "activation" ||
      typeof value.runId !== "string" ||
      typeof value.active !== "boolean" ||
      typeof value.toolsEnabled !== "boolean" ||
      typeof value.toolsDisabled !== "boolean" ||
      typeof value.rawRun !== "boolean" ||
      typeof value.fallbackActive !== "boolean"
    ) {
      return undefined;
    }
    return {
      runId: value.runId,
      active: value.active,
      toolsEnabled: value.toolsEnabled,
      toolsDisabled: value.toolsDisabled,
      rawRun: value.rawRun,
      fallbackActive: value.fallbackActive,
      ...(typeof value.allowlist === "string" ? { allowlist: value.allowlist } : {}),
    };
  } catch {
    return undefined;
  }
}

export function evaluateGatewayMatrixActivation(params: {
  diagnostics: readonly GatewayMatrixActivationDiagnostic[];
  rootRunId?: string;
  childRunIds: readonly string[];
  expectedEnabled: boolean;
}) {
  const requiredActivationRuns = [
    ...new Set([...(params.rootRunId ? [params.rootRunId] : []), ...params.childRunIds]),
  ];
  const observedActivation = params.diagnostics.filter((entry) =>
    requiredActivationRuns.includes(entry.runId),
  );
  // Isolated no-tool finalization is outside the surface being compared.
  const qualifyingActivation = observedActivation.filter(
    (entry) => entry.toolsEnabled && !entry.toolsDisabled && !entry.rawRun,
  );
  const activationComplete =
    Boolean(params.rootRunId) &&
    requiredActivationRuns.every((runId) =>
      qualifyingActivation.some((entry) => entry.runId === runId),
    );
  return {
    requiredActivationRuns,
    observedActivation,
    qualifyingActivation,
    activationComplete,
    actualCodeMode: activationComplete && qualifyingActivation.every((entry) => entry.active),
    engagement:
      activationComplete &&
      qualifyingActivation.every((entry) => entry.active === params.expectedEnabled),
  };
}

type DeliveredFileEvidence = {
  source: string;
  status: "captured" | "unavailable";
  path?: string;
  bytes?: number;
  sha256?: string;
  reason?: string;
};

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
  performanceGradingRevision?: string;
  settings: {
    executor: CodeModeExecutorId;
    thinking: string;
    timeoutSeconds: number;
    execTimeoutMs: number;
    maxOutputBytes: number;
    maxModelOutputTokens: number | null;
    runtime: "openclaw";
    fast: false;
    allowedTools: readonly string[];
  };
};

export type GatewayMatrixEvidence = GatewayMatrixWorkload & {
  behavior: Record<string, boolean>;
  taskElapsedMs?: number;
  taskResponseAt?: number;
  startupMs: number;
  traceAvailable: boolean;
  upstreamCalls?: number;
  outerCalls?: number;
  outerOutputBytes?: number;
  taskAssistantTurns?: number;
  deliveredFiles?: DeliveredFileEvidence[];
  interview: {
    skipped?: boolean;
    accounting?: MatrixUsageAccounting;
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
    deliveredFiles?: string;
  };
};

function matrixFixture(
  task: GatewayMatrixTask,
  repetition: number,
): GatewayMatrixFixture & { performance?: MatrixPerformanceFixture } {
  if (!isMatrixPerformanceTask(task)) {
    return createGatewayMatrixFixture(task, repetition);
  }
  const performance = createMatrixPerformanceFixture(task, repetition);
  return {
    prompt: performance.prompt,
    expected: { rubricVersion: performance.rubricVersion },
    pluginSource: performance.pluginSource ?? createGatewayMatrixPluginSource(""),
    requiredTools: performance.requiredTools,
    workspaceFiles: performance.workspaceFiles,
    interviewPrompt: "",
    performance,
  };
}

type BehaviorChecks = Record<string, boolean> & { answer: boolean; actualCodeMode: boolean };

/** Workload identity exists before launch, including when a cell cannot start. */
export function createGatewayMatrixWorkload(
  task: GatewayMatrixTask,
  repetition: number,
  thinking: string,
  timeoutSeconds: number,
  executor: CodeModeExecutorId = "node",
): GatewayMatrixWorkload {
  const fixture = matrixFixture(task, repetition);
  return {
    ...(fixture.performance ? { performanceGradingRevision: PERFORMANCE_GRADING_REVISION } : {}),
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
      .update(JSON.stringify(fixture.workspaceFiles ?? {}))
      .update(JSON.stringify(fixture.performance?.configPatch ?? {}))
      .update(fixture.performance?.rubricVersion ?? "contract")
      .update(fixture.performance ? PERFORMANCE_GRADING_REVISION : "")
      .update(fixture.performance ? JSON.stringify(fixture.performance.deliveredFiles) : "")
      .digest("hex"),
    settings: {
      executor,
      thinking,
      timeoutSeconds,
      execTimeoutMs: EXEC_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
      maxModelOutputTokens: fixture.performance ? null : MAX_MODEL_OUTPUT_TOKENS,
      runtime: "openclaw",
      fast: false,
      allowedTools: gatewayAllowedTools(
        task,
        fixture.requiredTools,
        fixture.performance?.allowedTools,
      ),
    },
  };
}

function gatewayAllowedTools(
  task: GatewayMatrixTask,
  fixtureTools: readonly string[],
  performanceTools?: readonly string[],
): readonly string[] {
  if (performanceTools) {
    return performanceTools;
  }
  if (task === "automation-contracts") {
    return ["automations"];
  }
  if (task === "process-contracts") {
    return ["exec", "process"];
  }
  if (task === "javascript-contracts") {
    return ["read", "write"];
  }
  if (task === "gateway-config-read") {
    return ["gateway"];
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
    const sessionKey =
      typeof event.matrixSessionKey === "string" ? event.matrixSessionKey : undefined;
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
            ...(sessionKey ? { sessionKey } : {}),
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
        ...(sessionKey ? { sessionKey } : {}),
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
        content: record(data.result) ? data.result.content : undefined,
        isError: data.isError === true,
        ...(typeof data.parentToolCallId === "string" ? { parentId: data.parentToolCallId } : {}),
        ...(sessionKey ? { sessionKey } : {}),
        eventIndex,
      });
    }
  }
  // Deferred Tool Search and Code Mode already persist the underlying activity.
  // Only ordinary direct calls need projection from their matching tool result.
  for (const outcome of outcomes) {
    const call = calls.find(
      (item) => item.id === outcome.id && item.sessionKey === outcome.sessionKey,
    );
    if (
      !call ||
      (call.name === "exec" && typeof call.args.code === "string") ||
      ["tool_search", "tool_describe", "tool_call", "wait"].includes(call.name) ||
      activities.some((item) => item.parentId === call.id && item.sessionKey === call.sessionKey)
    ) {
      continue;
    }
    activities.push({
      name: call.name,
      input: call.args,
      result: outcome.details,
      content: outcome.content,
      isError: outcome.isError,
      ...(call.sessionKey ? { sessionKey: call.sessionKey } : {}),
      eventIndex: outcome.eventIndex,
    });
  }
  activities.sort((left, right) => (left.eventIndex ?? 0) - (right.eventIndex ?? 0));
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

function callOutcomes(trace: GatewayMatrixTrace, call: ToolCall): ToolOutcome[] {
  let outcome = trace.outcomes.findLast((item) => item.id === call.id);
  const outcomes = outcome ? [outcome] : [];
  let cursor = trace.calls.indexOf(call);
  while (outcome && !outcome.isError && outcome.details.status === "waiting") {
    const runId = outcome.details.runId;
    if (typeof runId !== "string") {
      break;
    }
    const next = trace.calls.findIndex(
      (item, index) => index > cursor && item.name === "wait" && item.args.runId === runId,
    );
    const wait = trace.calls[next];
    if (!wait) {
      break;
    }
    cursor = next;
    outcome = trace.outcomes.findLast((item) => item.id === wait.id);
    if (outcome) {
      outcomes.push(outcome);
    }
  }
  return outcomes;
}

function settledCallOutcome(outcomes: readonly ToolOutcome[]): ToolOutcome | undefined {
  const outcome = outcomes.at(-1);
  return outcome && ["completed", "failed"].includes(String(outcome.details.status))
    ? outcome
    : undefined;
}

function completedCallOutcome(outcomes: readonly ToolOutcome[]): ToolOutcome | undefined {
  const outcome = settledCallOutcome(outcomes);
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

function isDirectApiRead(call: ToolCall, method: "list" | "read", argument: string): boolean {
  try {
    const program = parse(source(call), {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
    const statement = program.body[0];
    if (
      program.body.length !== 1 ||
      statement?.type !== "ReturnStatement" ||
      statement.argument?.type !== "AwaitExpression"
    ) {
      return false;
    }
    const invocation = statement.argument.argument;
    return (
      invocation.type === "CallExpression" &&
      !invocation.optional &&
      invocation.callee.type === "MemberExpression" &&
      !invocation.callee.computed &&
      !invocation.callee.optional &&
      invocation.callee.object.type === "Identifier" &&
      invocation.callee.object.name === "API" &&
      invocation.callee.property.type === "Identifier" &&
      invocation.callee.property.name === method &&
      invocation.arguments.length === 1 &&
      invocation.arguments[0]?.type === "Literal" &&
      invocation.arguments[0].value === argument
    );
  } catch {
    return false;
  }
}

function normalizeCaughtError(message: string): string {
  // Host activity retains the catalog ID; the guest bridge exposes the callable name.
  return message
    .replace(/\r\n/gu, "\n")
    .trim()
    .replace(/^(?:Error|ToolInputError):\s*/u, "")
    .replace(
      /^Invalid arguments for tool "openclaw:core:read":/u,
      'Invalid arguments for tool "read":',
    );
}

function matchesTextRead(activity: ToolActivity | undefined, expected: unknown): boolean {
  return (
    typeof expected === "string" &&
    activity?.result.kind === "text" &&
    activity.result.content === expected &&
    Array.isArray(activity.content) &&
    activity.content.length === 1 &&
    record(activity.content[0]) &&
    activity.content[0].type === "text" &&
    activity.content[0].text === expected
  );
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
  task: GatewayMatrixContractTask;
  expected: RecordValue;
  final: string;
  trace: GatewayMatrixTrace;
  receipts: readonly unknown[];
  probeCode?: string;
}): BehaviorChecks {
  const { task, trace, expected } = params;
  const receiptRows = params.receipts.filter(record);
  const receiptCalls = receiptRows.filter((row) => row.kind === "call");
  const codeModeInvocation = (item: ToolActivity) =>
    trace.calls.some((call) => call.id === item.parentId && call.name === "exec");
  const activity = trace.activities.filter((item) => !item.isError);
  const checks: BehaviorChecks = {
    answer: isDeepStrictEqual(jsonAnswer(params.final), expected),
    actualCodeMode:
      trace.calls.some((call) => call.name === "exec") &&
      trace.outcomes.some((outcome) =>
        ["completed", "waiting", "failed"].includes(String(outcome.details.status)),
      ),
  };
  if (task === "return-value-effects" || task === "result-save-invalid-json") {
    const execs = trace.calls.filter((call) => call.name === "exec");
    const probe = execs.length === 1 ? execs[0] : undefined;
    const outcomes = probe ? callOutcomes(trace, probe) : [];
    const outcome = completedCallOutcome(outcomes);
    const output = outcomes.flatMap((item) =>
      Array.isArray(item.details.output) ? item.details.output.filter(record) : [],
    );
    checks.exactProbeSource =
      probe !== undefined &&
      typeof params.probeCode === "string" &&
      source(probe).trim() === params.probeCode.trim();
    checks.observedProbeValue =
      outcome !== undefined && isDeepStrictEqual(outcome.details.value, expected);
    const toolName =
      task === "return-value-effects" ? "matrix_return_effect" : "matrix_serialization_seed";
    checks.singleProbeInvocation =
      trace.activities.length === 1 &&
      trace.activities.every(
        (item) =>
          !item.isError &&
          item.parentId === probe?.id &&
          item.name === toolName &&
          item.result.nonce === expected.nonce,
      );
    if (task === "return-value-effects") {
      checks.singleOutput =
        output.length === 1 && output[0]?.type === "text" && output[0].text === expected.marker;
      checks.exactlyOneEffect = isDeepStrictEqual(
        receiptRows.map(({ kind, tool, nonce }) => ({ kind, tool, nonce })),
        ["call", "effect"].map((kind) => ({ kind, tool: toolName, nonce: expected.nonce })),
      );
    } else {
      const rejected = output.map((item) =>
        item.type === "json" && record(item.value) ? item.value : {},
      );
      checks.rejectionsObserved =
        isDeepStrictEqual(
          rejected.map((item) => item.kind),
          expected.rejected,
        ) &&
        rejected.every((item) => typeof item.error === "string" && item.error.trim().length > 0);
      checks.singleSeedRead =
        receiptRows.length === 1 &&
        receiptRows[0]?.kind === "call" &&
        receiptRows[0].tool === toolName;
    }
  } else if (task === "gateway-config-read") {
    const read = trace.activities.length === 1 ? trace.activities[0] : undefined;
    const call = trace.calls.find((item) => item.id === read?.parentId && item.name === "exec");
    const outcome = call ? completedCallOutcome(callOutcomes(trace, call)) : undefined;
    const result = record(read?.result.result) ? read.result.result : undefined;
    const config = record(result?.config) ? result.config : undefined;
    checks.singleConfigRead =
      read !== undefined &&
      !read.isError &&
      read.name === "gateway" &&
      read.input.action === "config.get" &&
      read.input.path === "tools.codeMode";
    checks.configSettings =
      read?.result.ok === true &&
      result?.path === "tools.codeMode" &&
      config?.enabled === true &&
      (config.timeoutMs === undefined || config.timeoutMs === EXEC_TIMEOUT_MS) &&
      (config.maxOutputBytes === undefined || config.maxOutputBytes === MAX_OUTPUT_BYTES);
    checks.rawConfigReachedGuest =
      outcome !== undefined && isDeepStrictEqual(outcome.details.value, read?.result);
    checks.noFixtureEffects = receiptRows.length === 0;
  } else if (task === "invoices-auto-retention") {
    const firstFetch = trace.activities.find((item) => item.name === "matrix_invoice_export");
    const fetchCell = trace.calls.find((call) => call.id === firstFetch?.parentId);
    const fetched = fetchCell ? completedCallOutcome(callOutcomes(trace, fetchCell)) : undefined;
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
      completedCallOutcome(callOutcomes(trace, load)) !== undefined;
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
    checks.codeModeComposition = automations.length > 0 && automations.every(codeModeInvocation);
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
    checks.codeModeComposition =
      processes.length > 0 && [...launches, ...processes].every(codeModeInvocation);
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
      ? settledCallOutcome(callOutcomes(trace, settlementCell))
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
  } else if (task === "javascript-contracts") {
    const execs = trace.calls.filter((call) => call.name === "exec");
    checks.javascriptArguments = execs.every(
      (call) => !("language" in call.args) && !("typecheck" in call.args),
    );
    const completedOutput = (call: ToolCall) => {
      const outcomes = callOutcomes(trace, call);
      return completedCallOutcome(outcomes)
        ? JSON.stringify(outcomes.map((outcome) => outcome.details))
        : "";
    };
    const fileList = execs.find((call) => {
      if (!isDirectApiRead(call, "list", "tools/")) {
        return false;
      }
      const output = completedOutput(call);
      return ["read", "write"].every((name) => output.includes(`tools/${name}.d.ts`));
    });
    const declarations = ["read", "write"].map((name) =>
      execs.find((call) => {
        if (!isDirectApiRead(call, "read", `tools/${name}.d.ts`)) {
          return false;
        }
        const output = completedOutput(call);
        return output.includes(`declare function ${name}(`) && output.includes("string");
      }),
    );
    const reads = activity.filter((item) => item.name === "read");
    const writes = activity.filter((item) => item.name === "write");
    const sourceRead = reads.find((item) => path.basename(String(item.input.path)) === "facts.txt");
    const readback = reads.find((item) => path.basename(String(item.input.path)) === "result.txt");
    const firstToolCell = execs.find((call) =>
      trace.activities.some((item) => item.parentId === call.id),
    );
    const discovery = [fileList, ...declarations];
    checks.declarationsBeforeTools =
      firstToolCell !== undefined &&
      discovery.every((call, index) => {
        const next = discovery[index + 1] ?? firstToolCell;
        return (
          call !== undefined &&
          (completedCallOutcome(callOutcomes(trace, call))?.eventIndex ?? Infinity) <
            next.eventIndex
        );
      });
    const rejectedReads = trace.activities.filter(
      (item) => item.name === "read" && item.isError && item.input.path === 42,
    );
    const rejectedRead = rejectedReads.length === 1 ? rejectedReads[0] : undefined;
    checks.caughtArgumentError =
      rejectedRead !== undefined &&
      execs.some((call) => {
        if (call.id !== rejectedRead.parentId) {
          return false;
        }
        const actualError = rejectedRead.result.error;
        if (
          typeof actualError !== "string" ||
          !actualError.includes("Invalid arguments for tool")
        ) {
          return false;
        }
        const outcomes = callOutcomes(trace, call);
        if (!completedCallOutcome(outcomes)) {
          return false;
        }
        const emitted = outcomes.flatMap((outcome) =>
          Array.isArray(outcome.details.output) ? outcome.details.output.filter(record) : [],
        );
        return emitted.some(
          (item) =>
            item.type === "text" &&
            typeof item.text === "string" &&
            normalizeCaughtError(item.text) === normalizeCaughtError(actualError),
        );
      });
    const written = writes[0];
    checks.dependentReadWrite =
      rejectedRead !== undefined &&
      sourceRead !== undefined &&
      readback !== undefined &&
      writes.length === 1 &&
      written !== undefined &&
      path.basename(String(written.input.path)) === "result.txt" &&
      written.input.content === expected.verificationCode &&
      trace.activities.indexOf(rejectedRead) < trace.activities.indexOf(sourceRead) &&
      activity.indexOf(sourceRead) < activity.indexOf(written) &&
      activity.indexOf(written) < activity.indexOf(readback);
    checks.observedSource =
      typeof expected.verificationCode === "string" &&
      matchesTextRead(sourceRead, `verification_code=${expected.verificationCode}\n`);
    checks.observedReadback = matchesTextRead(readback, expected.verificationCode);
    checks.onlyFixtureAccess =
      reads.every(
        (item) =>
          item.input.path === sourceRead?.input.path || item.input.path === readback?.input.path,
      ) &&
      activity.length === reads.length + writes.length &&
      trace.activities.length === activity.length + rejectedReads.length &&
      trace.activities.every(codeModeInvocation);
  }

  return checks;
}

/** Claims support the interview; an attempted expired read also needs observed runtime evidence. */
export function evaluateGatewayMatrixInterview(
  task: GatewayMatrixContractTask,
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
    const outcome = settledCallOutcome(callOutcomes(interviewTrace, call));
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

type ResponseResult = {
  id?: string;
  status?: string;
  final: string;
  error?: string;
  usage?: unknown;
};

async function agentRequest(
  port: number,
  token: string,
  prompt: string,
  timeoutSeconds: number,
  previousId?: string,
  abortSignal?: AbortSignal,
  sessionKey?: string,
  maxOutputTokens?: number,
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
      ...(sessionKey ? { "x-openclaw-session-key": sessionKey } : {}),
      "x-openclaw-scopes": "operator.admin,operator.read,operator.write",
    },
    body: JSON.stringify({
      model: "openclaw/qa",
      input: prompt,
      ...(previousId ? { previous_response_id: previousId } : {}),
      ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
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
    ...(value.usage !== undefined ? { usage: value.usage } : {}),
    ...(record(value.error) && typeof value.error.message === "string"
      ? { error: value.error.message }
      : {}),
  };
}

async function captureDeliveredFiles(params: {
  workspace: string;
  artifactDir: string;
  outputDir: string;
  files: readonly string[];
  redact: (value: string) => string;
}): Promise<DeliveredFileEvidence[]> {
  const workspace = await fs.realpath(params.workspace);
  const evidence: DeliveredFileEvidence[] = [];
  const maxFileBytes = 1024 * 1024;
  let totalBytes = 0;
  for (const [index, relativeSource] of params.files.entries()) {
    try {
      if (index >= 16) {
        throw new Error("Delivered-file count exceeds 16.");
      }
      const file = path.resolve(workspace, relativeSource);
      if (path.isAbsolute(relativeSource) || !file.startsWith(`${workspace}${path.sep}`)) {
        throw new Error("Delivered file must stay within the workspace.");
      }
      if (!(await fs.lstat(file)).isFile()) {
        throw new Error("Delivered file must be a regular file, not a symlink.");
      }
      const resolved = await fs.realpath(file);
      if (!resolved.startsWith(`${workspace}${path.sep}`)) {
        throw new Error("Delivered file resolves outside the workspace.");
      }
      const handle = await fs.open(resolved, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      let content: string;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxFileBytes) {
          throw new Error(
            "Delivered file must be a single-link regular file no larger than 1 MiB.",
          );
        }
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, length);
          if (read.bytesRead === 0) {
            break;
          }
          length += read.bytesRead;
        }
        if (length !== stat.size) {
          throw new Error("Delivered file changed during capture.");
        }
        content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      } finally {
        await handle.close();
      }
      const redacted = redactForDevToolLog(params.redact(content));
      const bytes = Buffer.byteLength(redacted);
      if (bytes > maxFileBytes || totalBytes + bytes > 4 * maxFileBytes) {
        throw new Error("Redacted deliverables exceed the 1 MiB file or 4 MiB cell limit.");
      }
      const destination = path.join(
        params.artifactDir,
        "delivered",
        path.relative(workspace, file),
      );
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, redacted, { flag: "wx", mode: 0o600 });
      totalBytes += bytes;
      evidence.push({
        source: relativeSource,
        status: "captured",
        path: path.relative(params.outputDir, destination),
        bytes,
        sha256: createHash("sha256").update(redacted).digest("hex"),
      });
    } catch (error) {
      evidence.push({
        source: relativeSource,
        status: "unavailable",
        reason: redactForDevToolLog(
          params.redact(error instanceof Error ? error.message : "Delivered-file capture failed."),
        ).slice(0, 300),
      });
    }
  }
  return evidence;
}

/** Run a neutral workload or an explicit contract probe in a disposable Gateway. */
export async function runGatewayMatrixCell(
  params: RunCellParams & { cell: RunCellParams["cell"] & { task: GatewayMatrixTask } },
): Promise<CodeModeMatrixCellResult> {
  if (!params.runtime) {
    throw new Error("Built runtime entrypoint was not prepared");
  }
  const executor = params.executor ?? "node";
  const provider = params.cell.model.split("/")[0]!;
  const providerConfig: OpenClawConfig = {
    plugins: { allow: [provider], entries: { [provider]: { enabled: true } } },
  };
  const credentials = matrixProviderEnv(params.cell.model, providerConfig, process.env);
  const credentialValues = Object.values(credentials).filter((value): value is string =>
    Boolean(value),
  );
  if (credentialValues.length === 0) {
    throw new Error(`No API key environment input available for provider ${provider}`);
  }
  const fixture = matrixFixture(params.cell.task, params.cell.repetition);
  const performance = fixture.performance;
  const allowedTools = gatewayAllowedTools(
    params.cell.task,
    fixture.requiredTools,
    performance?.allowedTools,
  );
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-matrix-")),
  );
  const stateDir = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  const pluginDir = path.join(root, "fixture");
  const receiptsPath = path.join(root, "receipts.jsonl");
  const artifactDir = path.join(params.outputDir, "cells", params.cell.id);
  const rootSessionKey = `agent:qa:matrix:${randomUUID()}`;
  const token = `synthetic-matrix-${randomUUID()}`;
  const redact = (value: string) =>
    credentialValues.reduce(
      (text, secret) => text.replaceAll(secret, "[REDACTED]"),
      value.replaceAll(token, "[SYNTHETIC_GATEWAY_TOKEN]"),
    );
  const write = async (name: string, value: unknown) =>
    fs.writeFile(path.join(artifactDir, name), redact(`${JSON.stringify(value, null, 2)}\n`), {
      mode: 0o600,
    });
  const readReceipts = async (): Promise<unknown[]> =>
    (await fs.readFile(receiptsPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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
  for (const [name, content] of Object.entries(fixture.workspaceFiles ?? {})) {
    const file = path.resolve(workspace, name);
    if (!file.startsWith(`${workspace}${path.sep}`)) {
      throw new Error(`Fixture path escapes its workspace: ${name}`);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  if (fixture.processHelperSource !== undefined) {
    await fs.writeFile(path.join(workspace, "process-probe.mjs"), fixture.processHelperSource);
  }
  const port = await availablePort();
  const configPath = path.join(stateDir, "openclaw.json");
  const baseConfig = {
    logging: {
      level: "info",
      consoleLevel: "info",
      consoleStyle: "compact",
      file: path.join(root, "gateway.log"),
    },
    env: { shellEnv: { enabled: false } },
    agents: {
      defaults: {
        workspace,
        skipBootstrap: true,
        thinkingDefault: params.thinking,
        heartbeat: { every: "0m" },
        systemAgent: { agentId: "qa" },
      },
      entries: { qa: {} },
    },
    plugins: {
      allow: [
        provider,
        ...(executor === "quickjs" ? ["code-mode-quickjs"] : []),
        ...(fixture.requiredTools.length ? ["code-mode-matrix-fixture"] : []),
      ],
      slots: { memory: "none" },
      ...(fixture.requiredTools.length ? { load: { paths: [pluginDir] } } : {}),
      entries: {
        [provider]: { enabled: true },
        ...(executor === "quickjs" ? { "code-mode-quickjs": { enabled: true } } : {}),
        ...(fixture.requiredTools.length
          ? { "code-mode-matrix-fixture": { enabled: true, config: { receiptsPath } } }
          : {}),
      },
    },
    memory: { search: { enabled: false } },
    skills: { load: { watch: false } },
    discovery: { mdns: { mode: "off" } },
    tools: {
      profile: "full",
      allow: allowedTools,
      fs: { workspaceOnly: true },
      exec: { security: "full", ask: "off" },
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
  // Task-specific limits cannot change the selected treatment, runtime, or model settings.
  const cfg = mergeDeep(mergeDeep(baseConfig, performance?.configPatch ?? {}), {
    agents: matrixModelConfig(params.cell.model, params.thinking),
    tools: { codeMode: { enabled: params.cell.mode === "code", executor } },
  });
  await fs.writeFile(configPath, JSON.stringify(cfg), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    OPENCLAW_HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    TEMP: path.join(root, "tmp"),
    TMP: path.join(root, "tmp"),
    ...credentials,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(params.runtime.cwd, "dist", "extensions"),
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_ACPX_RUNTIME: "1",
    OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_DEBUG_CODE_MODE: "1",
    NO_COLOR: "1",
  };
  const startedAt = Date.now();
  const { createProcessSupervisor } = await import("../../src/process/supervisor/supervisor.js");
  const { runCommandWithTimeout } = await import("../../src/process/exec.js");
  const supervisor = createProcessSupervisor();
  const scopeKey = `code-mode-matrix:${randomUUID()}`;
  const cleanup = supervisor.acquireScopeCleanup(scopeKey, { processTree: "required-all" });
  let child: ManagedRun | undefined;
  let log = "";
  const pendingLogLines = { stdout: "", stderr: "" };
  const retryWarnings = new Map<string, string>();
  const activationDiagnostics = new Map<string, GatewayMatrixActivationDiagnostic>();
  const inspectLogLine = (line: string) => {
    for (const signature of ["[responses] retrying", "[session-recovery] Anthropic thinking"]) {
      if (line.includes(signature) && !retryWarnings.has(signature)) {
        retryWarnings.set(signature, line.slice(0, 4_096));
      }
    }
    const diagnostic = parseGatewayMatrixActivationDiagnostic(line);
    if (diagnostic) {
      activationDiagnostics.set(JSON.stringify(diagnostic), diagnostic);
    }
  };
  let failure: unknown;
  let cleanupCertain: boolean;
  let task: ResponseResult = { final: "" };
  let interview: ResponseResult = { final: "" };
  let taskEvents: unknown[] = [];
  let interviewEvents: unknown[] = [];
  let startupMs = 0;
  let taskElapsedMs: number | undefined;
  let taskResponseAt: number | undefined;
  let interviewElapsedMs: number | undefined;
  let taskStartedAt: number | undefined;
  let interviewStartedAt: number | undefined;
  let beforeTask: MatrixLedgerBoundary | undefined;
  let taskBoundary: MatrixLedgerBoundary | undefined;
  let ledger: MatrixSessionLedger | undefined;
  let taskRecords: unknown[] | undefined;
  let receipts: unknown[] = [];
  let taskReceipts: unknown[] | undefined;
  const runCli = async (args: string[]) => {
    const result = await runCommandWithTimeout(
      [process.execPath, ...params.runtime!.args, ...args],
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
    if (result.code !== 0 || result.cleanup === "uncertain") {
      throw new Error(
        `Benchmark CLI failed: ${redact(result.stderr).slice(-2_000) || result.cleanup || result.code}`,
      );
    }
    return JSON.parse(result.stdout) as unknown;
  };
  try {
    const capture = (stream: "stdout" | "stderr", chunk: string) => {
      log = `${log}${chunk}`.slice(-64 * 1024);
      const lines = `${pendingLogLines[stream]}${chunk}`.split(/\r?\n/u);
      pendingLogLines[stream] = (lines.pop() ?? "").slice(-16_384);
      for (const line of lines) {
        inspectLogLine(line);
      }
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
      timeoutMs: (params.timeoutSeconds * (performance ? 1 : 2) + 120) * 1_000,
      captureOutput: false,
      onStdout: (chunk) => capture("stdout", chunk),
      onStderr: (chunk) => capture("stderr", chunk),
    });
    await waitReady(child, port, params.abortSignal);
    const catalog = await runCli([
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
    ]);
    requireGatewayMatrixTools(catalog, allowedTools);
    await write("tool-catalog.json", catalog);
    beforeTask = captureMatrixLedgerBoundary(await readMatrixSessionLedger(stateDir));
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
        rootSessionKey,
        performance ? undefined : MAX_MODEL_OUTPUT_TOKENS,
      );
    } finally {
      taskResponseAt = Date.now();
      taskElapsedMs = taskResponseAt - taskStartedAt;
      taskReceipts = await readReceipts();
    }
    taskBoundary = captureMatrixLedgerBoundary(await readMatrixSessionLedger(stateDir));
    if (performance?.inspectSubagents) {
      const listed = await runCli(["tasks", "list", "--json", "--runtime", "subagent"]);
      taskRecords = record(listed) && Array.isArray(listed.tasks) ? listed.tasks : [];
      await write("task-records.json", taskRecords);
    }
    if (!performance) {
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
          rootSessionKey,
          MAX_MODEL_OUTPUT_TOKENS,
        );
      } finally {
        interviewElapsedMs = Date.now() - interviewStartedAt;
      }
    }
  } catch (error) {
    failure = error;
  } finally {
    if (taskStartedAt === undefined) {
      startupMs = Date.now() - startedAt;
    }
    child?.cancel("manual-cancel");
    cleanupCertain = true;
    for (const settle of [() => child?.wait(), cleanup, () => supervisor.shutdown()]) {
      try {
        await settle();
      } catch (error) {
        cleanupCertain = false;
        failure ??= error;
      }
    }
    if (taskStartedAt !== undefined) {
      try {
        ledger = await readMatrixSessionLedger(stateDir);
        const events = (selection: ReturnType<typeof selectMatrixLedgerRows>) =>
          selection.rows.map((row) =>
            record(row.event) ? { ...row.event, matrixSessionKey: row.sessionKey } : row.event,
          );
        taskEvents = events(
          selectMatrixLedgerRows({
            ledger,
            before: beforeTask,
            ...(interviewStartedAt !== undefined ? { after: taskBoundary } : {}),
            rootSessionKeys: [rootSessionKey],
          }),
        );
        if (interviewStartedAt !== undefined) {
          interviewEvents = events(
            selectMatrixLedgerRows({
              ledger,
              before: taskBoundary,
              rootSessionKeys: [rootSessionKey],
            }),
          );
        }
      } catch (error) {
        failure ??= error;
      }
    }
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
    if (ledger) {
      await write("session-ledger.json", ledger);
    }
    for (const line of Object.values(pendingLogLines)) {
      inspectLogLine(line);
    }
    await write("activation-diagnostics.json", [...activationDiagnostics.values()]);
    await fs.writeFile(path.join(artifactDir, "gateway.log"), redact(log), { mode: 0o600 });
  }
  const trace = collectGatewayMatrixTrace(taskEvents);
  const interviewTrace = collectGatewayMatrixTrace(interviewEvents);
  const accounting = ledger
    ? collectMatrixUsage({
        ledger,
        before: beforeTask,
        ...(interviewStartedAt !== undefined ? { after: taskBoundary } : {}),
        rootSessionKeys: [rootSessionKey],
        settled: cleanupCertain,
        terminalResponseObserved: task.status === "completed",
        rootUsage: task.usage,
        runtimeLog: [...retryWarnings.values(), log].join("\n"),
      })
    : undefined;
  const interviewAccounting =
    ledger && interviewStartedAt !== undefined
      ? collectMatrixUsage({
          ledger,
          before: taskBoundary,
          rootSessionKeys: [rootSessionKey],
          settled: cleanupCertain,
          terminalResponseObserved: interview.status === "completed",
          rootUsage: interview.usage,
          runtimeLog: [...retryWarnings.values(), log].join("\n"),
        })
      : undefined;
  const sessionActivation = [
    ...new Set(trace.calls.map((call) => call.sessionKey ?? rootSessionKey)),
  ].map((sessionKey) => {
    const calls = trace.calls.filter((call) => (call.sessionKey ?? rootSessionKey) === sessionKey);
    return {
      sessionKey,
      codeMode: calls.some((call) => call.name === "exec" && typeof call.args.code === "string"),
      toolCalls: calls.length,
    };
  });
  const {
    observedActivation,
    qualifyingActivation,
    activationComplete,
    actualCodeMode,
    engagement,
  } = evaluateGatewayMatrixActivation({
    diagnostics: [...activationDiagnostics.values()],
    rootRunId: task.id,
    childRunIds:
      ledger?.runs
        .filter((run) => run.requesterSessionKey === rootSessionKey)
        .map((run) => run.runId) ?? [],
    expectedEnabled: params.cell.mode === "code",
  });
  let behavior: Record<string, boolean>;
  if (performance) {
    try {
      behavior = await performance.evaluate({
        workspace,
        trace,
        receipts: taskReceipts,
        taskResponseAt,
        taskRecords,
      });
    } catch (error) {
      failure ??= error;
      behavior = { rubricCompleted: false };
    }
    behavior = {
      ...behavior,
      engagement,
      underlyingToolExecution: trace.activities.length > 0,
      finalResponsePresent: task.final.trim().length > 0,
    };
  } else {
    if (isMatrixPerformanceTask(params.cell.task)) {
      throw new Error("Missing performance fixture");
    }
    behavior = evaluateGatewayMatrixTask({
      task: params.cell.task,
      expected: fixture.expected,
      final: task.final,
      trace,
      receipts: taskReceipts,
      probeCode: fixture.probeCode,
    });
    if (params.cell.task === "javascript-contracts") {
      behavior.persistedFile =
        (await fs.readFile(path.join(workspace, "result.txt"), "utf8").catch(() => undefined)) ===
        fixture.expected.verificationCode;
    }
  }
  const deliveredFiles = performance
    ? await captureDeliveredFiles({
        workspace,
        artifactDir,
        outputDir: params.outputDir,
        files: performance.deliveredFiles,
        redact,
      })
    : undefined;
  if (deliveredFiles) {
    await write("delivered-files.json", deliveredFiles);
  }
  const interviewChecks =
    !performance && !isMatrixPerformanceTask(params.cell.task)
      ? evaluateGatewayMatrixInterview(params.cell.task, trace, interviewTrace, interview.final)
      : {};
  const identity =
    trace.models.length > 0 &&
    trace.models.every((model) => model === params.cell.model) &&
    (performance !== undefined ||
      (interviewTrace.models.length > 0 &&
        interviewTrace.models.every((model) => model === params.cell.model)));
  const behaviorPassed =
    Object.values(behavior).length > 0 && Object.values(behavior).every(Boolean);
  const passed =
    !failure &&
    cleanupCertain &&
    task.status === "completed" &&
    identity &&
    behaviorPassed &&
    (performance !== undefined ||
      (interview.status === "completed" && Object.values(interviewChecks).every(Boolean)));
  const finalAssistants = new Map<string, RecordValue>();
  for (const event of taskEvents) {
    if (!record(event)) {
      continue;
    }
    const message = record(event.message) ? event.message : event;
    if (message.role === "assistant") {
      finalAssistants.set(
        typeof event.matrixSessionKey === "string" ? event.matrixSessionKey : rootSessionKey,
        message,
      );
    }
  }
  const modelError = [...finalAssistants.values()]
    .filter((message) => message.stopReason === "error" && typeof message.errorMessage === "string")
    .map((message) => message.errorMessage)
    .join("\n");
  const error =
    failure instanceof Error
      ? redact(failure.message)
      : (task.error ?? interview.error ?? (!passed && modelError ? redact(modelError) : undefined));
  const providerFailure = !passed
    ? classifyCodeModeMatrixProviderFailure(redact(`${error ?? ""}\n${modelError}`))
    : null;
  const timedOut =
    failure instanceof Error &&
    (failure.name === "TimeoutError" || /timed out|deadline|timeout/iu.test(failure.message));
  const gateway: GatewayMatrixEvidence = {
    ...createGatewayMatrixWorkload(
      params.cell.task,
      params.cell.repetition,
      params.thinking,
      params.timeoutSeconds,
      executor,
    ),
    behavior,
    startupMs,
    traceAvailable: ledger !== undefined,
    ...(deliveredFiles ? { deliveredFiles } : {}),
    ...(taskElapsedMs !== undefined ? { taskElapsedMs } : {}),
    ...(taskResponseAt !== undefined ? { taskResponseAt } : {}),
    ...(ledger
      ? {
          upstreamCalls: trace.activities.length,
          outerCalls: trace.calls.length,
          outerOutputBytes: Buffer.byteLength(
            JSON.stringify(trace.outcomes.map((outcome) => outcome.content)),
          ),
          taskAssistantTurns: trace.assistantTurns,
        }
      : {}),
    interview: {
      ...(performance ? { skipped: true } : {}),
      traceAvailable: ledger !== undefined && interviewStartedAt !== undefined,
      ...(interviewElapsedMs !== undefined ? { elapsedMs: interviewElapsedMs } : {}),
      ...(interviewAccounting ? { accounting: interviewAccounting } : {}),
      answer: jsonAnswer(interview.final) ?? interview.final,
      rationaleReview: "required",
      checks: interviewChecks,
      ...(interviewStartedAt !== undefined ? { trace: interviewTrace } : {}),
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
      ...(deliveredFiles
        ? {
            deliveredFiles: path.relative(
              params.outputDir,
              path.join(artifactDir, "delivered-files.json"),
            ),
          }
        : {}),
    },
  };
  await write("evidence.json", {
    gateway,
    task,
    interview,
    accounting,
    sessionActivation,
    activationComplete,
    observedActivation,
    qualifyingActivation,
    cleanupCertain,
  });
  if (params.keepState || failure || !passed) {
    await write("retained-state.json", {
      root,
      reason: params.keepState ? "requested" : "failure inspection",
    });
  } else {
    await fs.rm(root, { recursive: true, force: true });
  }
  const slash = params.cell.model.indexOf("/");
  return {
    id: params.cell.id,
    executor,
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
    status: timedOut ? "timeout" : error ? "error" : "ok",
    elapsedMs: Date.now() - startedAt,
    expected: JSON.stringify(fixture.expected),
    final: redact(task.final),
    failureCategory: passed
      ? null
      : (providerFailure ??
        (timedOut ? "timeout" : null) ??
        (failure
          ? "harness_error"
          : !identity
            ? "model_mismatch"
            : !engagement
              ? "activation"
              : !behaviorPassed || task.status !== "completed"
                ? "tool_execution"
                : "interview_mismatch")),
    ...(error
      ? {
          diagnostics: error.slice(0, 8_000),
          error: { kind: "gateway_benchmark", message: error.slice(0, 2_000) },
        }
      : {}),
    codeModeEngaged: activationComplete ? actualCodeMode : null,
    observedProvider: identity ? params.cell.model.slice(0, slash) : null,
    observedModel: identity ? params.cell.model.slice(slash + 1) : null,
    ...(accounting ? { accounting } : {}),
    ...(ledger ? { assistantTurns: trace.assistantTurns } : {}),
    ...(trace.usage ? { usage: trace.usage } : {}),
    ...(accounting?.costComplete && accounting.costUsd !== null
      ? { costUsd: accounting.costUsd }
      : {}),
    oracle: {
      answer: performance ? null : behavior.answer === true,
      effect: behaviorPassed,
      engagement,
      identity,
      toolExecution: trace.activities.length > 0,
    },
    gateway,
  };
}

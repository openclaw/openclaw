import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AssistantMessage } from "../llm/types.js";
import type { MetaExecutorRegistry } from "../skills/meta/executors.js";
import type { MetaGateEvidence, MetaGateResult } from "../skills/meta/gates.js";
import { resumePersistedMetaPlan, runPersistedMetaPlan } from "../skills/meta/persisted-runner.js";
import {
  createDefaultMetaExecutorRegistry,
  createDefaultMetaInvokePlanRunner,
} from "../skills/meta/runtime.js";
import type { RuntimeMetaInvokePlanRunner } from "../skills/meta/runtime.js";
import type { JsonRecord, MetaRunStore } from "../skills/meta/store.js";
import { isPlainRecord } from "../skills/meta/template.js";
import { META_BLOCKED_TOOL_CALL_TARGET_NAMES } from "../skills/meta/types.js";
import type { SkillSnapshot } from "../skills/types.js";
import { isCodeModeControlTool } from "./code-mode-control-tools.js";
import type { AgentToolResult, AgentToolUpdateCallback } from "./runtime/index.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";
import type { AnyAgentTool } from "./tools/common.js";

const BLOCKED_META_TOOL_CALL_TARGET_NAMES = new Set<string>(META_BLOCKED_TOOL_CALL_TARGET_NAMES);
const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";
const META_SKILL_CREATOR_PREPARE_TOOL_NAME = "meta_skill_creator_prepare";

const META_TOOL_RESULT_DETAIL_ALLOWLISTS: Record<string, ReadonlySet<string>> = {
  [META_SKILL_CREATOR_PREPARE_TOOL_NAME]: new Set([
    "name",
    "description",
    "workflow",
    "skillKey",
    "proposalContent",
    "goal",
    "evidence",
    "gatesOk",
    "gates",
    "workshopAction",
    "workshopSkillName",
    "workshopProposalId",
    "trigger",
    "audience",
    "requiredTools",
    "supportFiles",
    "priorContext",
    "harvestedContext",
    "riskProfile",
    "representativeInvocation",
    "nextAction",
  ]),
  [SKILL_WORKSHOP_TOOL_NAME]: new Set([
    "id",
    "status",
    "kind",
    "skillName",
    "skillKey",
    "supportFileCount",
    "scanState",
    "proposedVersion",
  ]),
};

export type MetaInvokeToolRef = {
  current: readonly AnyAgentTool[];
};

export type MetaInvokeToolExecutor = (params: {
  tool: AnyAgentTool;
  toolName: string;
  toolCallId: string;
  parentToolCallId?: string;
  input: unknown;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}) => Promise<AgentToolResult<unknown>>;

export type MetaInvokeToolExecutorRef = {
  current?: MetaInvokeToolExecutor;
};

export type MetaInvokeLlmCompletionOptions = {
  config: OpenClawConfig;
  agentId: string;
  modelRef?: string;
  preferredProfile?: string;
  signal?: AbortSignal;
  prepareSimpleCompletionModelForAgent?: typeof prepareSimpleCompletionModelForAgent;
  completeWithPreparedSimpleCompletionModel?: typeof completeWithPreparedSimpleCompletionModel;
};

export type MetaInvokeAgentStepOptions = {
  sourceSessionKey?: string;
  sourceChannel?: string;
  defaultTimeoutMs?: number;
  runAgentStep?: typeof import("./tools/agent-step.js").runAgentStep;
};

export type MetaInvokePersistenceOptions = {
  store: MetaRunStore;
  agentId?: string;
  sessionKey?: string;
  agentRunId?: string;
  channelTargetJson?: JsonRecord;
  workspaceContextJson?: JsonRecord;
  triggerJson?: JsonRecord;
  originalInputSummary?: string;
  channelBindingJson?: JsonRecord;
  pauseTtlMs?: number;
};

export function isMetaInvokeTargetTool(tool: AnyAgentTool): boolean {
  return !BLOCKED_META_TOOL_CALL_TARGET_NAMES.has(tool.name) && !isCodeModeControlTool(tool);
}

export function filterMetaInvokeTargetTools(tools: readonly AnyAgentTool[]): AnyAgentTool[] {
  return tools.filter(isMetaInvokeTargetTool);
}

function readToolText(result: AgentToolResult<unknown>): string | undefined {
  const text = result.content
    ?.filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  return text || undefined;
}

function toMetaSafeJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(toMetaSafeJsonValue);
  }
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, toMetaSafeJsonValue(entry)]),
    );
  }
  return undefined;
}

function buildMetaVisibleToolDetails(params: {
  toolName: string;
  result: AgentToolResult<unknown>;
}): Record<string, unknown> | undefined {
  const allowlist = META_TOOL_RESULT_DETAIL_ALLOWLISTS[params.toolName];
  if (!allowlist || !isPlainRecord(params.result.details)) {
    return undefined;
  }
  const details = Object.fromEntries(
    Object.entries(params.result.details)
      .filter(([key]) => allowlist.has(key))
      .map(([key, value]) => [key, toMetaSafeJsonValue(value)])
      .filter((entry): entry is [string, unknown] => entry[1] !== undefined),
  );
  return Object.keys(details).length > 0 ? details : undefined;
}

function buildMetaVisibleToolResult(params: {
  toolName: string;
  result: AgentToolResult<unknown>;
  text?: string;
}): Record<string, unknown> {
  const details = buildMetaVisibleToolDetails({
    toolName: params.toolName,
    result: params.result,
  });
  return {
    ...(params.text ? { text: params.text } : {}),
    ...(details ? { details } : {}),
  };
}

function readAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim();
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function mapSkillWorkshopScanGateResult(scanState: string): MetaGateResult["result"] {
  if (scanState === "clean") {
    return "passed";
  }
  if (scanState === "failed" || scanState === "quarantined") {
    return "failed";
  }
  return "skipped";
}

function mapSkillWorkshopScanRiskLevel(scanState: string): string | undefined {
  if (scanState === "failed" || scanState === "quarantined") {
    return "high";
  }
  if (scanState === "pending") {
    return "medium";
  }
  return undefined;
}

function buildSkillWorkshopScanSummary(scanState: string): string {
  if (scanState === "clean") {
    return "Skill Workshop proposal scan is clean.";
  }
  if (scanState === "failed") {
    return "Skill Workshop proposal scan failed.";
  }
  if (scanState === "quarantined") {
    return "Skill Workshop proposal is quarantined by scanner policy.";
  }
  return `Skill Workshop proposal scan state is ${scanState}.`;
}

function readOptionalJsonRecordField(
  record: Record<string, unknown>,
  key: string,
): JsonRecord | undefined {
  const value = record[key];
  return isPlainRecord(value) ? value : undefined;
}

function readMetaGateResult(value: unknown): MetaGateResult | undefined {
  if (!isPlainRecord(value)) {
    return undefined;
  }
  const name = readStringField(value, "name");
  const result = readStringField(value, "result");
  if (!name || (result !== "passed" && result !== "failed" && result !== "skipped")) {
    return undefined;
  }
  const riskLevel = readStringField(value, "riskLevel");
  const summary = readStringField(value, "summary");
  const evidenceJson = readOptionalJsonRecordField(value, "evidenceJson");
  const artifactRefsJson = readOptionalJsonRecordField(value, "artifactRefsJson");
  return {
    name,
    result,
    ...(riskLevel ? { riskLevel } : {}),
    ...(summary ? { summary } : {}),
    ...(evidenceJson ? { evidenceJson } : {}),
    ...(artifactRefsJson ? { artifactRefsJson } : {}),
  };
}

function readMetaGateResultsFromOutput(output: Record<string, unknown>): MetaGateResult[] {
  const toolResult = isPlainRecord(output.result) ? output.result : undefined;
  const details = toolResult && isPlainRecord(toolResult.details) ? toolResult.details : undefined;
  const gates = details?.gates;
  return Array.isArray(gates)
    ? gates.map(readMetaGateResult).filter((entry): entry is MetaGateResult => Boolean(entry))
    : [];
}

function deriveSkillWorkshopGateEvidence(params: {
  result: { outputs: Record<string, Record<string, unknown>> };
}): MetaGateEvidence | undefined {
  const gateResults: MetaGateResult[] = [];
  let proposalId: string | undefined;
  for (const output of Object.values(params.result.outputs)) {
    gateResults.push(...readMetaGateResultsFromOutput(output));
    if (readStringField(output, "toolName") !== SKILL_WORKSHOP_TOOL_NAME) {
      continue;
    }
    const toolResult = isPlainRecord(output.result) ? output.result : undefined;
    const details =
      toolResult && isPlainRecord(toolResult.details) ? toolResult.details : undefined;
    if (!details) {
      continue;
    }
    const scanState = readStringField(details, "scanState");
    const id = readStringField(details, "id");
    if (!scanState || !id) {
      continue;
    }
    const riskLevel = mapSkillWorkshopScanRiskLevel(scanState);
    const status = readStringField(details, "status");
    const kind = readStringField(details, "kind");
    const skillName = readStringField(details, "skillName");
    const skillKey = readStringField(details, "skillKey");
    proposalId ??= id;
    gateResults.push({
      name: "skill_workshop_scan",
      result: mapSkillWorkshopScanGateResult(scanState),
      ...(riskLevel ? { riskLevel } : {}),
      summary: buildSkillWorkshopScanSummary(scanState),
      evidenceJson: {
        proposalId: id,
        scanState,
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
        ...(skillName ? { skillName } : {}),
        ...(skillKey ? { skillKey } : {}),
      },
    });
  }

  if (gateResults.length === 0) {
    return undefined;
  }
  return {
    results: gateResults,
    ...(proposalId ? { proposalId } : {}),
  };
}

function buildMetaCompletionPrompt(context: {
  renderedPrompt: string;
  renderedArgs: unknown;
}): string {
  const prompt = context.renderedPrompt.trim();
  if (!isPlainRecord(context.renderedArgs) || Object.keys(context.renderedArgs).length === 0) {
    return prompt;
  }
  return [prompt, "", `Input JSON:\n${JSON.stringify(context.renderedArgs, null, 2)}`]
    .filter(Boolean)
    .join("\n");
}

function readOptionalStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalPositiveIntegerField(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function normalizeChoice(value: string): string {
  return value.trim().toLowerCase();
}

function resolveClassifiedChoice(text: string, choices: readonly string[]): string {
  const normalizedChoices = new Map(choices.map((choice) => [normalizeChoice(choice), choice]));
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  const normalizedFirstLine = firstLine ? normalizeChoice(firstLine) : "";
  const exact = normalizedChoices.get(normalizedFirstLine);
  if (exact) {
    return exact;
  }

  const stripped = normalizedFirstLine.replace(/^["'`]|["'`.,;:]+$/g, "");
  const strippedMatch = normalizedChoices.get(stripped);
  if (strippedMatch) {
    return strippedMatch;
  }

  throw new Error(
    `llm_classify response did not match one of the declared choices: ${choices.join(", ")}`,
  );
}

async function completeMetaLlmStep(
  options: MetaInvokeLlmCompletionOptions,
  prompt: string,
): Promise<{
  message: AssistantMessage;
  text: string;
}> {
  const prepare =
    options.prepareSimpleCompletionModelForAgent ?? prepareSimpleCompletionModelForAgent;
  const complete =
    options.completeWithPreparedSimpleCompletionModel ?? completeWithPreparedSimpleCompletionModel;
  const prepared = await prepare({
    cfg: options.config,
    agentId: options.agentId,
    modelRef: options.modelRef,
    preferredProfile: options.preferredProfile,
  });
  if ("error" in prepared) {
    throw new Error(prepared.error);
  }

  const message = await complete({
    model: prepared.model,
    auth: prepared.auth,
    cfg: options.config,
    context: {
      messages: [
        {
          role: "user",
          content: prompt,
          timestamp: Date.now(),
        },
      ],
    },
    options: {
      signal: options.signal,
    },
  });
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw new Error(message.errorMessage || `LLM meta step stopped with ${message.stopReason}`);
  }
  const text = readAssistantText(message);
  if (!text) {
    throw new Error("LLM meta step returned no text output");
  }
  return { message, text };
}

function buildSkillExecutionPrompt(params: {
  skillName: string;
  skillDescription: string;
  skillSource: string;
  renderedPrompt: string;
  renderedArgs: unknown;
}): string {
  return [
    `Execute the OpenClaw skill "${params.skillName}".`,
    "",
    "Skill description:",
    params.skillDescription,
    "",
    "Skill instructions:",
    params.skillSource.trim(),
    "",
    "Task:",
    params.renderedPrompt.trim() || "Use the input JSON to perform the skill task.",
    "",
    isPlainRecord(params.renderedArgs) && Object.keys(params.renderedArgs).length > 0
      ? `Input JSON:\n${JSON.stringify(params.renderedArgs, null, 2)}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildLlmExecutors(
  options: MetaInvokeLlmCompletionOptions | undefined,
): MetaExecutorRegistry {
  if (!options) {
    return {};
  }
  return {
    llm_chat: async (context) => {
      const { message, text } = await completeMetaLlmStep(
        options,
        buildMetaCompletionPrompt(context),
      );
      return {
        text,
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        usage: message.usage,
      };
    },
    llm_classify: async (context) => {
      if (!context.step.choices || context.step.choices.length === 0) {
        throw new Error("llm_classify step requires choices");
      }
      const prompt = [
        buildMetaCompletionPrompt(context),
        "",
        "Choose exactly one of these options and respond with only that option:",
        ...context.step.choices.map((choice) => `- ${choice}`),
      ].join("\n");
      const { message, text } = await completeMetaLlmStep(options, prompt);
      return {
        text,
        choice: resolveClassifiedChoice(text, context.step.choices),
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        usage: message.usage,
      };
    },
  } satisfies Parameters<typeof createDefaultMetaInvokePlanRunner>[0];
}

function buildSkillExecExecutors(options: {
  llmCompletion?: MetaInvokeLlmCompletionOptions;
  skillsSnapshot?: SkillSnapshot;
}): MetaExecutorRegistry {
  const llmCompletion = options.llmCompletion;
  const resolvedSkills = options.skillsSnapshot?.resolvedSkills;
  if (!llmCompletion || !resolvedSkills?.length) {
    return {};
  }
  return {
    skill_exec: async (context) => {
      const skillName = context.step.skillName?.trim();
      if (!skillName) {
        throw new Error("skill_exec step requires skillName");
      }
      const skill = resolvedSkills.find((candidate) => candidate.name === skillName);
      if (!skill) {
        throw new Error(`skill_exec target skill not available: ${skillName}`);
      }
      if (skill.disableModelInvocation) {
        throw new Error(`skill_exec target skill disables model invocation: ${skillName}`);
      }

      const { message, text } = await completeMetaLlmStep(
        llmCompletion,
        buildSkillExecutionPrompt({
          skillName: skill.name,
          skillDescription: skill.description,
          skillSource: skill.source,
          renderedPrompt: context.renderedPrompt,
          renderedArgs: context.renderedArgs,
        }),
      );
      return {
        text,
        skillName: skill.name,
        skillFilePath: skill.filePath,
        provider: message.provider,
        model: message.model,
        stopReason: message.stopReason,
        usage: message.usage,
      };
    },
  } satisfies Parameters<typeof createDefaultMetaInvokePlanRunner>[0];
}

function buildAgentExecutors(
  options: MetaInvokeAgentStepOptions | undefined,
): MetaExecutorRegistry {
  if (!options) {
    return {};
  }
  return {
    agent: async (context) => {
      if (!isPlainRecord(context.renderedArgs)) {
        throw new Error("agent step args must render to an object");
      }
      const sessionKey = readOptionalStringField(context.renderedArgs, "sessionKey");
      if (!sessionKey) {
        throw new Error("agent step requires args.sessionKey");
      }
      const message =
        readOptionalStringField(context.renderedArgs, "message") ?? context.renderedPrompt;
      if (!message.trim()) {
        throw new Error("agent step requires a non-empty message or prompt");
      }
      const timeoutMs =
        readOptionalPositiveIntegerField(context.renderedArgs, "timeoutMs") ??
        options.defaultTimeoutMs ??
        60_000;
      const runAgentStep =
        options.runAgentStep ?? (await import("./tools/agent-step.js")).runAgentStep;
      const text = await runAgentStep({
        sessionKey,
        message,
        extraSystemPrompt: readOptionalStringField(context.renderedArgs, "extraSystemPrompt") ?? "",
        timeoutMs,
        channel: readOptionalStringField(context.renderedArgs, "channel"),
        lane: readOptionalStringField(context.renderedArgs, "lane"),
        transcriptMessage: readOptionalStringField(context.renderedArgs, "transcriptMessage"),
        sourceSessionKey: options.sourceSessionKey,
        sourceChannel: options.sourceChannel,
        sourceTool: "meta_invoke",
      });
      if (!text) {
        throw new Error(`agent step returned no assistant reply for session ${sessionKey}`);
      }
      return {
        text,
        sessionKey,
      };
    },
  } satisfies Parameters<typeof createDefaultMetaInvokePlanRunner>[0];
}

function asToolCallArgs(renderedArgs: unknown): Record<string, unknown> {
  if (renderedArgs === undefined) {
    return {};
  }
  if (!isPlainRecord(renderedArgs)) {
    throw new Error("tool_call args must render to an object");
  }
  return renderedArgs;
}

function requireToolName(toolName: string | undefined): string {
  const normalized = toolName?.trim();
  if (!normalized) {
    throw new Error("tool_call step requires toolName");
  }
  if (BLOCKED_META_TOOL_CALL_TARGET_NAMES.has(normalized)) {
    throw new Error(`tool_call steps cannot invoke ${normalized}`);
  }
  return normalized;
}

function requireTool(tools: readonly AnyAgentTool[], name: string): AnyAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`tool_call target tool not available: ${name}`);
  }
  return tool;
}

function requireToolExecutor(ref: MetaInvokeToolExecutorRef | undefined): MetaInvokeToolExecutor {
  if (!ref?.current) {
    throw new Error("tool_call executor unavailable for this run");
  }
  return ref.current;
}

function buildMetaToolCallId(options: {
  parentToolCallId?: string;
  invocationSequence: number;
  stepId: string;
}): string {
  const parentPart = options.parentToolCallId?.trim() || "run";
  return `meta-${parentPart}-${options.invocationSequence}-${options.stepId}`;
}

function injectMetaRunInputContext(
  input: Record<string, unknown>,
  persistence: MetaInvokePersistenceOptions | undefined,
): Record<string, unknown> {
  const sessionKey = persistence?.sessionKey?.trim();
  if (!sessionKey) {
    return input;
  }
  const existingMetaValue = input["_meta"];
  const existingMeta = isPlainRecord(existingMetaValue) ? existingMetaValue : {};
  return {
    ...input,
    _meta: {
      ...existingMeta,
      sessionKey,
    },
  };
}

export function createAgentMetaInvokePlanRunner(options: {
  toolsRef: MetaInvokeToolRef;
  toolExecutorRef?: MetaInvokeToolExecutorRef;
  llmCompletion?: MetaInvokeLlmCompletionOptions;
  skillsSnapshot?: SkillSnapshot;
  agentStep?: MetaInvokeAgentStepOptions;
  persistence?: MetaInvokePersistenceOptions;
  signal?: AbortSignal;
  onUpdate?: AgentToolUpdateCallback;
}): RuntimeMetaInvokePlanRunner {
  let invocationSequence = 0;
  return async (runOptions) => {
    const currentInvocationSequence = ++invocationSequence;
    const input = injectMetaRunInputContext(runOptions.input, options.persistence);
    const executors: MetaExecutorRegistry = {
      ...buildLlmExecutors(options.llmCompletion),
      ...buildSkillExecExecutors({
        llmCompletion: options.llmCompletion,
        skillsSnapshot: options.skillsSnapshot,
      }),
      ...buildAgentExecutors(options.agentStep),
      tool_call: async (context) => {
        const toolName = requireToolName(context.step.toolName);
        const tool = requireTool(options.toolsRef.current, toolName);
        const parentToolCallId = runOptions.parentToolCallId?.trim() || undefined;
        const result = await requireToolExecutor(options.toolExecutorRef)({
          tool,
          toolName,
          toolCallId: buildMetaToolCallId({
            parentToolCallId,
            invocationSequence: currentInvocationSequence,
            stepId: context.step.id,
          }),
          ...(parentToolCallId ? { parentToolCallId } : {}),
          input: asToolCallArgs(context.renderedArgs),
          signal: options.signal,
          onUpdate: options.onUpdate,
        });
        const text = readToolText(result);
        return {
          result: buildMetaVisibleToolResult({ toolName, result, ...(text ? { text } : {}) }),
          toolName,
          ...(text ? { text } : {}),
        };
      },
    };
    if (options.persistence) {
      if (options.persistence.sessionKey) {
        const pendingPause = options.persistence.store.readPendingPauseForSession(
          options.persistence.sessionKey,
        );
        const pendingRun = pendingPause
          ? options.persistence.store.readRun(pendingPause.runId)
          : null;
        if (pendingRun?.status === "paused" && pendingRun.skillName === runOptions.plan.name) {
          return await resumePersistedMetaPlan({
            plan: runOptions.plan,
            input,
            executors: createDefaultMetaExecutorRegistry(executors),
            store: options.persistence.store,
            ...(options.persistence.agentId ? { agentId: options.persistence.agentId } : {}),
            sessionKey: options.persistence.sessionKey,
            ...(options.persistence.agentRunId
              ? { agentRunId: options.persistence.agentRunId }
              : {}),
            ...(options.persistence.channelTargetJson
              ? { channelTargetJson: options.persistence.channelTargetJson }
              : {}),
            ...(options.persistence.workspaceContextJson
              ? { workspaceContextJson: options.persistence.workspaceContextJson }
              : {}),
            ...(options.persistence.triggerJson
              ? { triggerJson: options.persistence.triggerJson }
              : {}),
            ...(options.persistence.originalInputSummary
              ? { originalInputSummary: options.persistence.originalInputSummary }
              : {}),
            ...(options.persistence.channelBindingJson
              ? { channelBindingJson: options.persistence.channelBindingJson }
              : {}),
            ...(options.persistence.pauseTtlMs
              ? { pauseTtlMs: options.persistence.pauseTtlMs }
              : {}),
            deriveGateEvidence: deriveSkillWorkshopGateEvidence,
          });
        }
      }
      return await runPersistedMetaPlan({
        plan: runOptions.plan,
        input,
        executors: createDefaultMetaExecutorRegistry(executors),
        store: options.persistence.store,
        ...(options.persistence.agentId ? { agentId: options.persistence.agentId } : {}),
        ...(options.persistence.sessionKey ? { sessionKey: options.persistence.sessionKey } : {}),
        ...(options.persistence.agentRunId ? { agentRunId: options.persistence.agentRunId } : {}),
        ...(options.persistence.channelTargetJson
          ? { channelTargetJson: options.persistence.channelTargetJson }
          : {}),
        ...(options.persistence.workspaceContextJson
          ? { workspaceContextJson: options.persistence.workspaceContextJson }
          : {}),
        ...(options.persistence.triggerJson
          ? { triggerJson: options.persistence.triggerJson }
          : {}),
        ...(options.persistence.originalInputSummary
          ? { originalInputSummary: options.persistence.originalInputSummary }
          : {}),
        ...(options.persistence.channelBindingJson
          ? { channelBindingJson: options.persistence.channelBindingJson }
          : {}),
        ...(options.persistence.pauseTtlMs ? { pauseTtlMs: options.persistence.pauseTtlMs } : {}),
        deriveGateEvidence: deriveSkillWorkshopGateEvidence,
      });
    }
    const runner = createDefaultMetaInvokePlanRunner(executors);
    return await runner({
      ...runOptions,
      input,
    });
  };
}

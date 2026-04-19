import { type EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness";
import {
  mapExecDecisionToOutcome,
  requestPluginApproval,
  type AppServerApprovalOutcome,
  waitForPluginApprovalDecision,
} from "./plugin-approval-roundtrip.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

type ApprovalOptionMap = {
  allowOnce?: string;
  allowAlways?: string;
  deny?: string;
  cancel?: string;
};

type BridgeableApprovalPrompt = {
  itemId?: string;
  questionId: string;
  title: string;
  description: string;
  options: ApprovalOptionMap;
};

export async function handleCodexAppServerToolUserInputRequest(params: {
  requestParams: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  signal?: AbortSignal;
}): Promise<JsonValue | undefined> {
  const requestParams = isJsonObject(params.requestParams) ? params.requestParams : undefined;
  if (!matchesCurrentTurn(requestParams, params.threadId, params.turnId)) {
    return undefined;
  }
  const approvalPrompt = readBridgeableApprovalPrompt(requestParams);
  if (!approvalPrompt) {
    return undefined;
  }

  const outcome = await requestPluginApprovalOutcome({
    paramsForRun: params.paramsForRun,
    title: approvalPrompt.title,
    description: approvalPrompt.description,
    itemId: approvalPrompt.itemId,
    signal: params.signal,
  });
  return buildToolUserInputResponse(
    approvalPrompt.questionId,
    resolveToolUserInputAnswer(approvalPrompt.options, outcome),
  );
}

function matchesCurrentTurn(
  requestParams: JsonObject | undefined,
  threadId: string,
  turnId: string,
): boolean {
  if (!requestParams) {
    return true;
  }
  const requestThreadId = readString(requestParams, "threadId");
  const requestTurnId = readString(requestParams, "turnId");
  if (requestThreadId && requestThreadId !== threadId) {
    return false;
  }
  if (requestTurnId && requestTurnId !== turnId) {
    return false;
  }
  return true;
}

function readBridgeableApprovalPrompt(
  requestParams: JsonObject | undefined,
): BridgeableApprovalPrompt | undefined {
  if (!requestParams) {
    return undefined;
  }
  const rawQuestions = Array.isArray(requestParams.questions) ? requestParams.questions : [];
  if (rawQuestions.length !== 1) {
    return undefined;
  }
  const question = isJsonObject(rawQuestions[0]) ? rawQuestions[0] : undefined;
  if (!question || question.isSecret === true) {
    return undefined;
  }

  const header = readString(question, "header") ?? "Codex app tool approval";
  const prompt = readString(question, "question") ?? header;
  const approvalText = `${header}\n${prompt}`.toLowerCase();
  if (
    !/\bapprove\b|\bapproval\b/.test(approvalText) &&
    !/\btool call\b|\bapp tool\b/.test(approvalText)
  ) {
    return undefined;
  }

  const options = readApprovalOptions(question);
  if (!options.allowOnce || (!options.deny && !options.cancel)) {
    return undefined;
  }

  const questionId = readString(question, "id");
  if (!questionId) {
    return undefined;
  }

  const optionLines = readOptionLines(question);
  return {
    itemId: readString(requestParams, "itemId"),
    questionId,
    title: header,
    description: [prompt, optionLines].filter(Boolean).join("\n\n"),
    options,
  };
}

function readApprovalOptions(question: JsonObject): ApprovalOptionMap {
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  const options: ApprovalOptionMap = {};
  for (const entry of rawOptions) {
    const option = isJsonObject(entry) ? entry : undefined;
    const label = readString(option, "label");
    if (!label) {
      continue;
    }
    const description = readString(option, "description");
    const normalized = `${label} ${description ?? ""}`.trim().toLowerCase();
    if (!options.allowAlways && isSessionApprovalOption(normalized)) {
      options.allowAlways = label;
      continue;
    }
    if (!options.deny && /\b(deny|decline|reject|block|disallow|no)\b/.test(normalized)) {
      options.deny = label;
      continue;
    }
    if (!options.cancel && /\b(cancel|abort|stop)\b/.test(normalized)) {
      options.cancel = label;
      continue;
    }
    if (!options.allowOnce && /\b(allow|approve|accept|yes)\b/.test(normalized)) {
      options.allowOnce = label;
    }
  }
  return options;
}

function readOptionLines(question: JsonObject): string | undefined {
  const rawOptions = Array.isArray(question.options) ? question.options : [];
  const lines = rawOptions
    .map((entry) => {
      const option = isJsonObject(entry) ? entry : undefined;
      const label = readString(option, "label");
      if (!label) {
        return undefined;
      }
      const description = readString(option, "description");
      return description ? `- ${label}: ${description}` : `- ${label}`;
    })
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) {
    return undefined;
  }
  return ["Options:", ...lines].join("\n");
}

async function requestPluginApprovalOutcome(params: {
  paramsForRun: EmbeddedRunAttemptParams;
  title: string;
  description: string;
  itemId?: string;
  signal?: AbortSignal;
}): Promise<AppServerApprovalOutcome> {
  try {
    const requestResult = await requestPluginApproval({
      paramsForRun: params.paramsForRun,
      title: params.title,
      description: params.description,
      severity: "warning",
      toolName: "codex_app_tool_approval",
      toolCallId: params.itemId,
    });

    const approvalId = requestResult?.id;
    if (!approvalId) {
      return "unavailable";
    }

    const decision = Object.prototype.hasOwnProperty.call(requestResult, "decision")
      ? requestResult.decision
      : await waitForPluginApprovalDecision({ approvalId, signal: params.signal });
    return mapExecDecisionToOutcome(decision);
  } catch {
    return params.signal?.aborted ? "cancelled" : "denied";
  }
}

function resolveToolUserInputAnswer(
  options: ApprovalOptionMap,
  outcome: AppServerApprovalOutcome,
): string | undefined {
  if (outcome === "approved-session") {
    return options.allowAlways ?? options.allowOnce;
  }
  if (outcome === "approved-once") {
    return options.allowOnce ?? options.allowAlways;
  }
  if (outcome === "cancelled") {
    return options.cancel ?? options.deny;
  }
  return options.deny ?? options.cancel;
}

function buildToolUserInputResponse(questionId: string, answer: string | undefined): JsonValue {
  if (!answer) {
    return { answers: {} };
  }
  return {
    answers: {
      [questionId]: {
        answers: [answer],
      },
    },
  };
}

function isSessionApprovalOption(value: string): boolean {
  return /\b(always|session|connection)\b/.test(value) && /\b(allow|approve|accept)\b/.test(value);
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

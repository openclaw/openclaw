import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentConfig } from "./agent-scope.js";

export type ExecutionGateMode = "off" | "warn" | "enforce";

type ExecutionGateConfig = {
  mode?: ExecutionGateMode;
};

export type DetectExecutionIntentSignalsParams = {
  userPrompt?: string;
  assistantTexts?: string[];
  hasToolMetas?: boolean;
  hasClientToolCall?: boolean;
  hasToolError?: boolean;
  didSendViaMessagingTool?: boolean;
  successfulCronAdds?: number;
};

export type ExecutionIntentSignals = {
  ackWithoutExecution: boolean;
  pseudoToolCallTextCount: number;
  commitmentSample?: string;
  pseudoToolCallSamples?: string[];
  actionRequestLikely: boolean;
};

const ACTION_REQUEST_PATTERNS: RegExp[] = [
  /\b(run|start|continue|check|investigate|fix|audit|scan|parse|search|read|open|restart|launch|deploy)\b/i,
  /\b(сделай|сделать|запусти|запустить|продолжи|проверь|проверить|почини|исправь|аудит|разбери|прочитай)\b/i,
];

const EXECUTION_COMMITMENT_PATTERNS: RegExp[] = [
  /\b(i(?:'ll| will)|we(?:'ll| will)|i(?:'m| am)|starting(?: now)?|launching(?: now)?|running(?: now)?|checking(?: now)?|continuing(?: now)?|working on it|on it)\b/i,
  /\b(принял|запускаю|проверяю|сделаю|делаю|начинаю|продолжаю|выполняю|запущу|проверю)\b/i,
];

const PSEUDO_TOOL_CALL_LINE_PATTERNS: RegExp[] = [
  /^\s*[a-z_][a-z0-9_./-]*(?::\d+)?\s*\([^)]*\)\s*$/i,
  /^\s*[a-z_][a-z0-9_./-]*\d+\s*\(\s*\{.*\}\s*\)\s*$/i,
  /^\s*[a-z_][a-z0-9_./-]*\s*:\s*\d+\s*\([^)]*\)\s*$/i,
];

function normalizeTexts(texts: string[] | undefined): string[] {
  if (!Array.isArray(texts)) {
    return [];
  }
  return texts
    .map((text) => (typeof text === "string" ? text.trim() : ""))
    .filter((text) => text.length > 0);
}

function isLikelyActionRequest(userPrompt: string | undefined): boolean {
  const prompt = userPrompt?.trim();
  if (!prompt) {
    return true;
  }
  return ACTION_REQUEST_PATTERNS.some((pattern) => pattern.test(prompt));
}

function findCommitmentSample(assistantTexts: string[]): string | undefined {
  for (const text of assistantTexts) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("```")) {
        continue;
      }
      if (EXECUTION_COMMITMENT_PATTERNS.some((pattern) => pattern.test(trimmed))) {
        return trimmed.slice(0, 240);
      }
    }
  }
  return undefined;
}

function detectPseudoToolCallLines(assistantTexts: string[]): string[] {
  const matches: string[] = [];
  for (const text of assistantTexts) {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("```")) {
        continue;
      }
      if (PSEUDO_TOOL_CALL_LINE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
        matches.push(trimmed.slice(0, 240));
      }
    }
  }
  return matches;
}

function hasExecutionArtifacts(params: DetectExecutionIntentSignalsParams): boolean {
  if (params.hasToolMetas || params.hasClientToolCall || params.hasToolError) {
    return true;
  }
  if (params.didSendViaMessagingTool) {
    return true;
  }
  return (params.successfulCronAdds ?? 0) > 0;
}

export function resolveExecutionGateMode(params: {
  cfg?: OpenClawConfig;
  agentId?: string;
}): ExecutionGateMode {
  const global = (params.cfg?.agents?.defaults?.executionGate as ExecutionGateConfig | undefined)
    ?.mode;
  const local =
    params.cfg && params.agentId
      ? (
          resolveAgentConfig(params.cfg, params.agentId)?.executionGate as
            | ExecutionGateConfig
            | undefined
        )?.mode
      : undefined;
  return local ?? global ?? "off";
}

export function detectExecutionIntentSignals(
  params: DetectExecutionIntentSignalsParams,
): ExecutionIntentSignals {
  const assistantTexts = normalizeTexts(params.assistantTexts);
  const actionRequestLikely = isLikelyActionRequest(params.userPrompt);
  const commitmentSample = findCommitmentSample(assistantTexts);
  const pseudoToolCallSamples = detectPseudoToolCallLines(assistantTexts);
  const pseudoToolCallTextCount = pseudoToolCallSamples.length;
  const ackWithoutExecution =
    actionRequestLikely && !!commitmentSample && !hasExecutionArtifacts(params);

  return {
    ackWithoutExecution,
    pseudoToolCallTextCount,
    commitmentSample,
    pseudoToolCallSamples: pseudoToolCallSamples.slice(0, 3),
    actionRequestLikely,
  };
}

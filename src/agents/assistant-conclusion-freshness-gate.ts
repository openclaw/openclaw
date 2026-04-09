import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  detectToolResultReplayPolicyMeta,
  getToolResultReplayMetadata,
  STALE_TOOL_RESULT_REPLAY_THRESHOLD_MS,
} from "./tool-result-replay-metadata.js";

export const ASSISTANT_FRESHNESS_GATE_TEMPLATE_A =
  "Freshness check required for this question. Before answering, you must make a fresh tool call in this turn to verify the current environment state. Do not answer from prior assistant conclusions or prior tool results alone, even if similar results already appear in history.";

export const ASSISTANT_FRESHNESS_GATE_HISTORY_WINDOW = 50;
export const ASSISTANT_FRESHNESS_GATE_ENV = "OPENCLAW_EXPERIMENT_ASSISTANT_FRESHNESS_GATE";

export type AssistantConclusionQuestionType = "plugin_install_state" | "config_key_presence";

export type AssistantFreshnessState = "not_high_risk" | "fresh" | "stale" | "missing";

export type AssistantConclusionFreshnessGateResult = {
  questionType?: AssistantConclusionQuestionType;
  diagnosticType?: string;
  freshnessState: AssistantFreshnessState;
  prependSystemContext?: string;
  templateId?: "A";
  matchedTimestamp?: number;
};

function trimToDefinedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizePrompt(prompt: string): string {
  return prompt.toLowerCase();
}

function detectPluginInstallQuestion(prompt: string): boolean {
  return (
    /(plugin|plugins|插件|plugins\.entries|plugins\.installs)/iu.test(prompt) &&
    /(installed|install|enabled|enable|loaded|status|what.*plugins|哪些插件|什么插件|装了|安装|启用|还在|状态)/iu.test(
      prompt,
    )
  );
}

function detectConfigPresenceQuestion(prompt: string): boolean {
  return (
    /(config|配置|openclaw\.json|plugins\.installs|plugins\.entries)/iu.test(prompt) &&
    /(exists|exist|present|value|key|有|有没有|存在|值|配置项|字段|参数)/iu.test(prompt)
  );
}

export function isAssistantConclusionFreshnessGateEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = trimToDefinedString(env[ASSISTANT_FRESHNESS_GATE_ENV])?.toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

export function detectAssistantConclusionQuestionType(
  prompt: string,
): {
  questionType: AssistantConclusionQuestionType;
  diagnosticType: string;
  diagnosticTargetHint?: string;
} | null {
  const normalized = normalizePrompt(prompt);
  if (detectConfigPresenceQuestion(normalized)) {
    return {
      questionType: "config_key_presence",
      diagnosticType: "openclaw.config_snapshot",
      diagnosticTargetHint: extractConfigTargetHint(normalized),
    };
  }
  if (detectPluginInstallQuestion(normalized)) {
    return {
      questionType: "plugin_install_state",
      diagnosticType: "openclaw.plugins_list",
    };
  }
  return null;
}

function isReplayOmitted(message: AgentMessage): boolean {
  const meta = (message as { __openclaw?: unknown }).__openclaw;
  return (
    !!meta &&
    typeof meta === "object" &&
    (meta as { replayOmitted?: unknown }).replayOmitted === true
  );
}

function parseFiniteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getMessageTimestamp(message: AgentMessage): number | undefined {
  return parseFiniteTimestamp((message as { timestamp?: unknown }).timestamp);
}

type AssistantToolCallBlock = {
  type?: unknown;
  id?: unknown;
  toolCallId?: unknown;
  toolUseId?: unknown;
  call_id?: unknown;
  name?: unknown;
  toolName?: unknown;
  functionName?: unknown;
  arguments?: unknown;
  input?: unknown;
};

function extractHistoricalToolCallData(
  block: AssistantToolCallBlock,
): { id?: string; name?: string; args: unknown } | null {
  const type = trimToDefinedString(block?.type);
  if (type !== "toolCall" && type !== "toolUse" && type !== "functionCall") {
    return null;
  }
  const id =
    trimToDefinedString(block.id) ??
    trimToDefinedString(block.toolCallId) ??
    trimToDefinedString(block.toolUseId) ??
    trimToDefinedString(block.call_id);
  const name =
    trimToDefinedString(block.name) ??
    trimToDefinedString(block.toolName) ??
    trimToDefinedString(block.functionName);
  const args = block.arguments ?? block.input;
  return { id, name, args };
}

function isErroredToolResult(message: AgentMessage): boolean {
  return (message as { isError?: unknown }).isError === true;
}

function inferDiagnosticTypeFromHistoricalToolCall(params: {
  messages: AgentMessage[];
  toolResultIndex: number;
  toolResult: AgentMessage;
}): { diagnosticType?: string; diagnosticTarget?: string } | undefined {
  const toolResult = params.toolResult as {
    toolCallId?: unknown;
    toolUseId?: unknown;
    toolName?: unknown;
  };
  const toolCallId =
    trimToDefinedString(toolResult.toolCallId) ?? trimToDefinedString(toolResult.toolUseId);
  const toolName = trimToDefinedString(toolResult.toolName)?.toLowerCase() ?? "unknown";
  if (!toolCallId) {
    return undefined;
  }

  for (let index = params.toolResultIndex - 1; index >= 0; index -= 1) {
    const message = params.messages[index] as {
      role?: unknown;
      content?: unknown;
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    for (const block of message.content as AssistantToolCallBlock[]) {
      const normalized = extractHistoricalToolCallData(block);
      if (!normalized) {
        continue;
      }
      if (normalized.id !== toolCallId) {
        continue;
      }
      const inferred = detectToolResultReplayPolicyMeta({
        toolName: normalized.name ?? toolName,
        args: normalized.args,
        taggedAt: getMessageTimestamp(params.toolResult) ?? Date.now(),
      });
      if (!inferred?.diagnosticType) {
        return undefined;
      }
      return {
        diagnosticType: inferred.diagnosticType,
        diagnosticTarget: inferred.diagnosticTarget,
      };
    }
  }
  return undefined;
}

function inferReplayDiagnosticType(params: {
  messages: AgentMessage[];
  toolResultIndex: number;
  toolResult: AgentMessage;
}): { diagnosticType?: string; diagnosticTarget?: string } | undefined {
  const replayMeta = getToolResultReplayMetadata(params.toolResult);
  if (replayMeta?.diagnosticType) {
    return {
      diagnosticType: replayMeta.diagnosticType,
      diagnosticTarget: replayMeta.diagnosticTarget,
    };
  }
  const inferred = inferDiagnosticTypeFromHistoricalToolCall(params);
  if (!inferred?.diagnosticType) {
    return undefined;
  }
  return inferred;
}

function extractConfigTargetHint(normalizedPrompt: string): string | undefined {
  if (/plugins\.entries/iu.test(normalizedPrompt)) {
    return "plugins.entries";
  }
  if (/plugins\.installs/iu.test(normalizedPrompt)) {
    return "plugins.installs";
  }
  const dottedPathMatches = normalizedPrompt.match(/\b[a-z_][a-z0-9_-]*(?:\.[a-z0-9_-]+)+\b/giu);
  return dottedPathMatches?.[0];
}

function extractConfigPathFromDiagnosticTarget(diagnosticTarget?: string): string | undefined {
  const target = trimToDefinedString(diagnosticTarget)?.toLowerCase();
  if (!target) {
    return undefined;
  }
  if (/openclaw\.json/iu.test(target)) {
    return "__full_config_snapshot__";
  }
  const gatewayPath = target.match(/^[a-z_][a-z0-9_-]*(?:\.[a-z0-9_-]+)+$/iu);
  if (gatewayPath?.[0]) {
    return gatewayPath[0].toLowerCase();
  }
  const cliPath = target.match(/openclaw\s+config\s+get(?:\s+--\S+)*\s+["']?([^"'`\s]+)["']?/iu);
  return cliPath?.[1]?.toLowerCase();
}

function isSameOrNestedConfigPath(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

function matchesDiagnosticTarget(params: {
  questionType: AssistantConclusionQuestionType;
  diagnosticTargetHint?: string;
  evidenceDiagnosticTarget?: string;
}): boolean {
  if (params.questionType !== "config_key_presence") {
    return true;
  }
  const hint = trimToDefinedString(params.diagnosticTargetHint)?.toLowerCase();
  if (!hint) {
    return true;
  }
  const evidencePath = extractConfigPathFromDiagnosticTarget(params.evidenceDiagnosticTarget);
  if (!evidencePath || evidencePath === "__full_config_snapshot__") {
    return true;
  }
  return isSameOrNestedConfigPath(hint, evidencePath);
}

export function resolveAssistantConclusionFreshnessGate(params: {
  prompt: string;
  messages: unknown[];
  now?: number;
  historyWindow?: number;
}): AssistantConclusionFreshnessGateResult {
  const detected = detectAssistantConclusionQuestionType(params.prompt);
  if (!detected) {
    return { freshnessState: "not_high_risk" };
  }

  const now = params.now ?? Date.now();
  const historyWindow = params.historyWindow ?? ASSISTANT_FRESHNESS_GATE_HISTORY_WINDOW;
  const recentMessages = params.messages
    .slice(Math.max(0, params.messages.length - historyWindow))
    .filter((message): message is AgentMessage => !!message && typeof message === "object");

  let sawMatchingEvidence = false;

  for (let index = recentMessages.length - 1; index >= 0; index -= 1) {
    const message = recentMessages[index];
    if ((message as { role?: unknown }).role !== "toolResult") {
      continue;
    }
    const diagnostic = inferReplayDiagnosticType({
      messages: recentMessages,
      toolResultIndex: index,
      toolResult: message,
    });
    if (diagnostic?.diagnosticType !== detected.diagnosticType) {
      continue;
    }
    if (
      !matchesDiagnosticTarget({
        questionType: detected.questionType,
        diagnosticTargetHint: detected.diagnosticTargetHint,
        evidenceDiagnosticTarget: diagnostic.diagnosticTarget,
      })
    ) {
      continue;
    }
    sawMatchingEvidence = true;
    if (isReplayOmitted(message)) {
      continue;
    }
    if (isErroredToolResult(message)) {
      continue;
    }
    const replayMeta = getToolResultReplayMetadata(message);
    const messageTimestamp =
      getMessageTimestamp(message) ?? parseFiniteTimestamp(replayMeta?.taggedAt);
    if (messageTimestamp === undefined) {
      continue;
    }
    if (now - messageTimestamp <= STALE_TOOL_RESULT_REPLAY_THRESHOLD_MS) {
      return {
        questionType: detected.questionType,
        diagnosticType: detected.diagnosticType,
        freshnessState: "fresh",
        matchedTimestamp: messageTimestamp,
      };
    }
  }

  return {
    questionType: detected.questionType,
    diagnosticType: detected.diagnosticType,
    freshnessState: sawMatchingEvidence ? "stale" : "missing",
    prependSystemContext: ASSISTANT_FRESHNESS_GATE_TEMPLATE_A,
    templateId: "A",
  };
}

export function summarizeAssistantConclusionFreshnessGateLog(
  result: AssistantConclusionFreshnessGateResult,
): string {
  if (result.freshnessState === "not_high_risk") {
    return "assistant freshness gate: not_high_risk";
  }
  const parts = [
    `assistant freshness gate: ${result.freshnessState}`,
    result.questionType ? `questionType=${result.questionType}` : undefined,
    result.diagnosticType ? `diagnosticType=${result.diagnosticType}` : undefined,
    result.templateId ? `template=${result.templateId}` : undefined,
    typeof result.matchedTimestamp === "number"
      ? `matchedTs=${result.matchedTimestamp}`
      : undefined,
  ].filter((part): part is string => !!trimToDefinedString(part));
  return parts.join(" ");
}

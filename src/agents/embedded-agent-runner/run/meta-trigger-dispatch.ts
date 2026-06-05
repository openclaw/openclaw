import type { AssistantMessage, Usage } from "../../../llm/types.js";
import {
  findDeterministicMetaTriggerMatch,
  findMetaTriggerMatches,
  type MetaSkillCatalog,
  type MetaTriggerMatch,
} from "../../../skills/meta/catalog.js";
import type { MetaRunStore, MetaRunStorePauseRecord } from "../../../skills/meta/store.js";
import type { AgentToolResult } from "../../runtime/index.js";
import type { AnyAgentTool } from "../../tools/common.js";

const META_INVOKE_TOOL_NAME = "meta_invoke";

export type DeterministicMetaTriggerDispatchResult = {
  match?: MetaTriggerMatch;
  resumedPause?: {
    pauseId: string;
    runId: string;
    skillName: string;
  };
  finalText: string;
  assistant: AssistantMessage;
};

type ExecuteMetaInvokeTool = (params: {
  tool: AnyAgentTool;
  toolCallId: string;
  args: Record<string, unknown>;
}) => Promise<AgentToolResult<unknown>>;

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function readToolResultText(result: AgentToolResult<unknown>): string {
  return (
    result.content
      ?.filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim() ?? ""
  );
}

function buildMetaTriggerInput(inputText: string): Record<string, unknown> {
  return {
    request: inputText,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function schemaAllowsAdditionalProperties(schema: Record<string, unknown>): boolean {
  return schema.additionalProperties !== false;
}

function isStringCompatibleSchema(schema: unknown): boolean {
  if (!isPlainRecord(schema)) {
    return true;
  }
  const type = schema.type;
  if (type === undefined || type === "string") {
    return true;
  }
  return Array.isArray(type) && type.includes("string");
}

function buildPendingPauseResumeInput(params: {
  inputText: string;
  pause: MetaRunStorePauseRecord;
}): Record<string, unknown> {
  const schema = params.pause.schemaJson;
  const required = readStringArray(schema.required);
  const properties = isPlainRecord(schema.properties) ? schema.properties : {};
  if (required.length === 1 && isStringCompatibleSchema(properties[required[0]])) {
    return {
      [required[0]]: params.inputText,
    };
  }
  if (!schemaAllowsAdditionalProperties(schema)) {
    return {};
  }
  return buildMetaTriggerInput(params.inputText);
}

function hasMetaInvokeTool(tools: readonly AnyAgentTool[]): boolean {
  return tools.some((tool) => tool.name === META_INVOKE_TOOL_NAME);
}

function formatSoftMetaTriggerMatch(match: MetaTriggerMatch): string {
  return [
    `- ${match.plan.name}`,
    `trigger=${JSON.stringify(match.trigger)}`,
    `match=${match.kind}`,
    `description=${JSON.stringify(match.plan.description)}`,
  ].join(" ");
}

export function buildSoftMetaTriggerHint(params: {
  catalog?: MetaSkillCatalog;
  inputText: string;
  tools: readonly AnyAgentTool[];
}): string | undefined {
  if (!params.catalog || params.catalog.plans.length === 0 || !hasMetaInvokeTool(params.tools)) {
    return undefined;
  }
  const matches = findMetaTriggerMatches(params.catalog, params.inputText);
  if (matches.length === 0) {
    return undefined;
  }
  const deterministicMatches = matches.filter((match) => match.kind === "deterministic");
  if (deterministicMatches.length === 1 && matches.length === 1) {
    return undefined;
  }
  return [
    "Meta skill trigger hint:",
    'The current user request may match registered meta skills, but the match is soft or ambiguous. Do not invoke a meta skill automatically. If one candidate clearly fits the user\'s intent, call `meta_invoke` with its `skill_name` and an `input` object containing at least `{ "request": <current user request> }`. Otherwise continue normally.',
    "Candidates:",
    ...matches.map(formatSoftMetaTriggerMatch),
  ].join("\n");
}

export async function dispatchDeterministicMetaTrigger(params: {
  catalog?: MetaSkillCatalog;
  inputText: string;
  tools: readonly AnyAgentTool[];
  executeMetaInvokeTool: ExecuteMetaInvokeTool;
  toolCallId: string;
  assistant: Pick<AssistantMessage, "api" | "provider" | "model">;
  pendingPause?: {
    store: MetaRunStore;
    sessionKey?: string;
  };
  nowMs?: () => number;
}): Promise<DeterministicMetaTriggerDispatchResult | undefined> {
  if (!params.catalog || params.catalog.plans.length === 0) {
    return undefined;
  }
  const metaInvokeTool = params.tools.find((tool) => tool.name === META_INVOKE_TOOL_NAME);
  if (!metaInvokeTool) {
    return undefined;
  }

  const pendingPauseDispatch = resolvePendingPauseDispatch({
    catalog: params.catalog,
    inputText: params.inputText,
    pendingPause: params.pendingPause,
    nowMs: params.nowMs,
  });
  if (pendingPauseDispatch) {
    const result = await params.executeMetaInvokeTool({
      tool: metaInvokeTool,
      toolCallId: params.toolCallId,
      args: {
        skill_name: pendingPauseDispatch.skillName,
        input: pendingPauseDispatch.input,
      },
    });
    const finalText = readToolResultText(result);
    if (!finalText) {
      throw new Error(
        `Pending meta pause "${pendingPauseDispatch.pause.pauseId}" produced no final text.`,
      );
    }
    return {
      resumedPause: {
        pauseId: pendingPauseDispatch.pause.pauseId,
        runId: pendingPauseDispatch.pause.runId,
        skillName: pendingPauseDispatch.skillName,
      },
      finalText,
      assistant: buildMetaDispatchAssistant({
        finalText,
        assistant: params.assistant,
        nowMs: params.nowMs,
      }),
    };
  }

  const match = findDeterministicMetaTriggerMatch(params.catalog, params.inputText);
  if (!match) {
    return undefined;
  }

  const result = await params.executeMetaInvokeTool({
    tool: metaInvokeTool,
    toolCallId: params.toolCallId,
    args: {
      skill_name: match.plan.name,
      input: buildMetaTriggerInput(params.inputText),
    },
  });
  const finalText = readToolResultText(result);
  if (!finalText) {
    throw new Error(`Deterministic meta trigger "${match.plan.name}" produced no final text.`);
  }

  return {
    match,
    finalText,
    assistant: buildMetaDispatchAssistant({
      finalText,
      assistant: params.assistant,
      nowMs: params.nowMs,
    }),
  };
}

function resolvePendingPauseDispatch(params: {
  catalog: MetaSkillCatalog;
  inputText: string;
  pendingPause?: {
    store: MetaRunStore;
    sessionKey?: string;
  };
  nowMs?: () => number;
}):
  | {
      pause: MetaRunStorePauseRecord;
      skillName: string;
      input: Record<string, unknown>;
    }
  | undefined {
  const sessionKey = params.pendingPause?.sessionKey?.trim();
  if (!params.pendingPause || !sessionKey) {
    return undefined;
  }
  const pause = params.pendingPause.store.readPendingPauseForSession(
    sessionKey,
    params.nowMs?.() ?? Date.now(),
  );
  if (!pause) {
    return undefined;
  }
  const run = params.pendingPause.store.readRun(pause.runId);
  if (!run || run.status !== "paused") {
    return undefined;
  }
  if (!params.catalog.plans.some((plan) => plan.name === run.skillName)) {
    return undefined;
  }
  return {
    pause,
    skillName: run.skillName,
    input: buildPendingPauseResumeInput({
      inputText: params.inputText,
      pause,
    }),
  };
}

function buildMetaDispatchAssistant(params: {
  finalText: string;
  assistant: Pick<AssistantMessage, "api" | "provider" | "model">;
  nowMs?: () => number;
}): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.finalText }],
    api: params.assistant.api,
    provider: params.assistant.provider,
    model: params.assistant.model,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: params.nowMs?.() ?? Date.now(),
  };
}

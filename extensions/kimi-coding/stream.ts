import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import {
  resolveOpenAIRequestReasoning,
  streamSimple,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";
import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeOpenAICompatibleReasoningReplay,
  streamWithPayloadPatch,
  transformProviderStreamMessages,
} from "openclaw/plugin-sdk/provider-stream-shared";
import {
  asFiniteNumberInRange,
  asOptionalObjectRecord,
  isRecord,
  parseBooleanValue,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { isKimiK3ModelId, KIMI_K3_THINKING_EFFORTS } from "./provider-policy-api.js";

const TOOL_CALLS_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const TOOL_CALLS_SECTION_END = "<|tool_calls_section_end|>";
const TOOL_CALL_BEGIN = "<|tool_call_begin|>";
const TOOL_CALL_ARGUMENT_BEGIN = "<|tool_call_argument_begin|>";
const TOOL_CALL_END = "<|tool_call_end|>";

type KimiThinkingType = "enabled" | "disabled";
type KimiThinkingConfig = {
  type: KimiThinkingType;
  budget_tokens?: number;
};
type KimiThinkingLevel = NonNullable<ProviderWrapStreamFnContext["thinkingLevel"]>;

const KIMI_ANTHROPIC_THINKING_BUDGETS: Record<Exclude<KimiThinkingLevel, "off">, number> = {
  minimal: 1024,
  low: 1024,
  medium: 4096,
  high: 8192,
  adaptive: 8192,
  xhigh: 8192,
  max: 8192,
};
const KIMI_ANTHROPIC_VISIBLE_OUTPUT_RESERVE_TOKENS = 1024;
const KIMI_ANTHROPIC_MIN_OUTPUT_TOKENS = 16000;

function ensureKimiAnthropicMaxTokens(
  payloadObj: Record<string, unknown>,
  thinkingConfig: KimiThinkingConfig,
): void {
  if (thinkingConfig.type !== "enabled" || thinkingConfig.budget_tokens === undefined) {
    return;
  }
  const required = Math.max(
    KIMI_ANTHROPIC_MIN_OUTPUT_TOKENS,
    thinkingConfig.budget_tokens + KIMI_ANTHROPIC_VISIBLE_OUTPUT_RESERVE_TOKENS,
  );
  const current = asFiniteNumberInRange(payloadObj.max_tokens, { min: 1 });
  payloadObj.max_tokens =
    current === undefined ? required : Math.max(Math.floor(current), required);
}

function normalizeKimiThinkingType(value: unknown): KimiThinkingType | undefined {
  if (isRecord(value)) {
    return normalizeKimiThinkingType(value.type);
  }
  const enabled = parseBooleanValue(value, {
    truthy: ["enabled", "enable", "on", "true"],
    falsy: ["disabled", "disable", "off", "false"],
  });
  return enabled === undefined ? undefined : enabled ? "enabled" : "disabled";
}

function normalizeKimiThinkingConfig(value: unknown): KimiThinkingConfig | undefined {
  const type = normalizeKimiThinkingType(value);
  if (!type) {
    return undefined;
  }
  if (type === "disabled" || !isRecord(value)) {
    return { type };
  }
  const budgetTokens = asFiniteNumberInRange(value.budget_tokens ?? value.budgetTokens, {
    min: 1024,
  });
  return budgetTokens === undefined
    ? { type: "enabled" }
    : { type: "enabled", budget_tokens: Math.floor(budgetTokens) };
}

function resolveKimiThinkingConfig(
  configured: KimiThinkingConfig | undefined,
  thinkingLevel: KimiThinkingLevel | undefined,
): KimiThinkingConfig {
  const levelBudgetTokens =
    thinkingLevel && thinkingLevel !== "off"
      ? KIMI_ANTHROPIC_THINKING_BUDGETS[thinkingLevel]
      : undefined;
  if (configured) {
    return configured.type === "enabled" && configured.budget_tokens === undefined
      ? { type: "enabled", budget_tokens: levelBudgetTokens ?? 1024 }
      : configured;
  }
  if (!thinkingLevel || thinkingLevel === "off") {
    return { type: "disabled" };
  }
  return levelBudgetTokens === undefined
    ? { type: "enabled" }
    : { type: "enabled", budget_tokens: levelBudgetTokens };
}

function parseKimiTaggedToolCalls(text: string): ToolCall[] | null {
  const trimmed = text.trim();
  // Kimi emits tagged tool-call sections as standalone text blocks on this path.
  if (!trimmed.startsWith(TOOL_CALLS_SECTION_BEGIN) || !trimmed.endsWith(TOOL_CALLS_SECTION_END)) {
    return null;
  }

  let cursor = TOOL_CALLS_SECTION_BEGIN.length;
  const sectionEndIndex = trimmed.length - TOOL_CALLS_SECTION_END.length;
  const toolCalls: ToolCall[] = [];

  while (cursor < sectionEndIndex) {
    while (cursor < sectionEndIndex && /\s/.test(trimmed[cursor] ?? "")) {
      cursor += 1;
    }
    if (cursor >= sectionEndIndex) {
      break;
    }
    if (!trimmed.startsWith(TOOL_CALL_BEGIN, cursor)) {
      return null;
    }

    const nameStart = cursor + TOOL_CALL_BEGIN.length;
    const argMarkerIndex = trimmed.indexOf(TOOL_CALL_ARGUMENT_BEGIN, nameStart);
    if (argMarkerIndex < 0 || argMarkerIndex >= sectionEndIndex) {
      return null;
    }

    const rawId = trimmed.slice(nameStart, argMarkerIndex).trim();
    if (!rawId) {
      return null;
    }

    const argsStart = argMarkerIndex + TOOL_CALL_ARGUMENT_BEGIN.length;
    const callEndIndex = trimmed.indexOf(TOOL_CALL_END, argsStart);
    if (callEndIndex < 0 || callEndIndex > sectionEndIndex) {
      return null;
    }

    const rawArgs = trimmed.slice(argsStart, callEndIndex).trim();
    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(rawArgs);
    } catch {
      return null;
    }
    if (!isRecord(parsedArgs)) {
      return null;
    }

    const name = rawId.replace(/:\d+$/, "");
    if (!name) {
      return null;
    }

    toolCalls.push({
      type: "toolCall",
      id: rawId,
      name,
      arguments: parsedArgs,
    });

    cursor = callEndIndex + TOOL_CALL_END.length;
  }

  return toolCalls.length > 0 ? toolCalls : null;
}

function rewriteKimiTaggedToolCallsInMessage(message: unknown): void {
  const record = asOptionalObjectRecord(message);
  if (!record || !Array.isArray(record.content)) {
    return;
  }

  let changed = false;
  const nextContent: unknown[] = [];
  for (const block of record.content) {
    const typedBlock = asOptionalObjectRecord(block);
    const parsed =
      typedBlock?.type === "text" && typeof typedBlock.text === "string"
        ? parseKimiTaggedToolCalls(typedBlock.text)
        : null;
    if (!parsed) {
      nextContent.push(block);
      continue;
    }

    nextContent.push(...parsed);
    changed = true;
  }

  if (!changed) {
    return;
  }

  record.content = nextContent;
  if (record.stopReason === "stop") {
    record.stopReason = "toolUse";
  }
}

function createKimiToolCallMarkupWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const maybeStream = underlying(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream) =>
        transformProviderStreamMessages(stream, rewriteKimiTaggedToolCallsInMessage),
      );
    }
    return transformProviderStreamMessages(maybeStream, rewriteKimiTaggedToolCallsInMessage);
  };
}

export function wrapKimiProviderStream(ctx: ProviderWrapStreamFnContext): StreamFn {
  const configured = normalizeKimiThinkingConfig(ctx.extraParams?.thinking);
  const extraBody = asOptionalObjectRecord(
    ctx.extraParams?.extra_body ?? ctx.extraParams?.extraBody,
  );
  const templateKwargs = asOptionalObjectRecord(
    extraBody?.chat_template_kwargs ??
      ctx.extraParams?.chat_template_kwargs ??
      ctx.extraParams?.chatTemplateKwargs,
  );
  const underlying = ctx.streamFn ?? streamSimple;
  return createKimiToolCallMarkupWrapper((model, context, options) => {
    const api = ctx.sourceApi ?? model.api;
    const anthropic = api === "anthropic-messages";
    const k3 = anthropic && isKimiK3ModelId(model.id);
    const openaiK3 = api === "openai-completions" && isKimiK3ModelId(model.id);
    const thinkingLevel = options?.reasoning ?? ctx.thinkingLevel ?? (k3 ? "high" : undefined);
    const thinkingConfig = resolveKimiThinkingConfig(configured, thinkingLevel);
    const enabledLevel =
      thinkingLevel && thinkingLevel !== "off" ? thinkingLevel : k3 || openaiK3 ? "high" : "low";
    // Replay needs scalar effort; legacy adaptive keeps its resolved thinking budget.
    const nativeLevel = enabledLevel === "adaptive" ? "high" : enabledLevel;
    const reasoning =
      thinkingConfig.type === "disabled"
        ? "off"
        : k3
          ? KIMI_K3_THINKING_EFFORTS[nativeLevel]
          : nativeLevel;
    const runtimeModel = k3
      ? { ...model, compat: { ...model.compat, allowEmptySignature: true } }
      : openaiK3
        ? { ...model, thinkingLevelMap: { ...KIMI_K3_THINKING_EFFORTS, ...model.thinkingLevelMap } }
        : model;
    return streamWithPayloadPatch(
      underlying,
      runtimeModel,
      context,
      { ...options, reasoning },
      (payloadObj) => {
        delete payloadObj.reasoning;
        delete payloadObj.reasoning_effort;
        delete payloadObj.reasoningEffort;
        stripAnthropicCacheControlMarkers(payloadObj);

        if (k3) {
          const outputConfig = isRecord(payloadObj.output_config)
            ? { ...payloadObj.output_config }
            : {};
          if (thinkingConfig.type === "disabled") {
            payloadObj.thinking = { type: "disabled" };
            delete outputConfig.effort;
          } else {
            // K3 always uses adaptive thinking; the selected level controls its supported effort.
            payloadObj.thinking = { type: "adaptive", display: "summarized" };
            outputConfig.effort = reasoning;
          }
          if (Object.keys(outputConfig).length > 0) {
            payloadObj.output_config = outputConfig;
          } else {
            delete payloadObj.output_config;
          }
          return;
        }

        payloadObj.thinking = anthropic ? { ...thinkingConfig } : { type: thinkingConfig.type };
        if (anthropic) {
          ensureKimiAnthropicMaxTokens(payloadObj, thinkingConfig);
        } else {
          // A generated root effort would outrank explicit vLLM template kwargs.
          if (openaiK3 && reasoning !== "off" && templateKwargs?.reasoning_effort === undefined) {
            const { effort } = resolveOpenAIRequestReasoning(runtimeModel, reasoning);
            if (effort !== undefined) {
              payloadObj.reasoning_effort = effort;
            }
          }
          normalizeOpenAICompatibleReasoningReplay(payloadObj, {
            thinkingEnabled: thinkingConfig.type === "enabled",
            shouldBackfillAssistantMessage: (message) =>
              Array.isArray(message.tool_calls) && message.tool_calls.length > 0,
          });
        }
      },
    );
  });
}

function stripContentArrayCacheControl(value: unknown): void {
  if (!Array.isArray(value)) {
    return;
  }

  for (const block of value) {
    const record = asOptionalObjectRecord(block);
    if (!record) {
      continue;
    }
    delete record.cache_control;
    if (record.type === "tool_result") {
      stripContentArrayCacheControl(record.content);
    }
  }
}

function stripAnthropicCacheControlMarkers(payloadObj: Record<string, unknown>): void {
  stripContentArrayCacheControl(payloadObj.system);

  if (!Array.isArray(payloadObj.messages)) {
    return;
  }

  for (const message of payloadObj.messages) {
    stripContentArrayCacheControl(asOptionalObjectRecord(message)?.content);
  }
}

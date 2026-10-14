import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import {
  type JsonSchemaObject,
  validateJsonSchemaValue,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { readFiniteNumberParam, readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  asPositiveSafeInteger,
  normalizeOptionalString,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import { llmTaskToolDefinition } from "./llm-task-tool-definition.js";

function stripCodeFences(s: string): string {
  const trimmed = s.trim();
  const m = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (m) {
    return (m[1] ?? "").trim();
  }
  return trimmed;
}

function resolveLlmTaskModelRef(params: {
  api: OpenClawPluginApi;
  provider?: string;
  rawModel?: string;
  preserveProvider?: boolean;
}): { provider?: string; model?: string } {
  const defaultProvider =
    normalizeOptionalString(params.provider) ??
    normalizeOptionalString(params.api.runtime.agent.defaults.provider);
  const rawModel = normalizeOptionalString(params.rawModel);
  const providerPrefix = params.provider?.trim();
  const selectedModelRef = {
    provider: params.provider,
    model:
      providerPrefix && rawModel?.startsWith(`${providerPrefix}/`)
        ? rawModel.slice(providerPrefix.length + 1)
        : rawModel,
  };
  if (!rawModel || !defaultProvider) {
    return selectedModelRef;
  }

  const cfg = params.api.config;
  const aliasIndex = cfg ? buildModelAliasIndex({ cfg, defaultProvider }) : undefined;
  const resolved = resolveModelRefFromString({
    cfg,
    raw: rawModel,
    defaultProvider,
    aliasIndex,
  });
  // Selected providers own nested model IDs, but configured aliases still own their target.
  if (params.preserveProvider && !resolved?.alias) {
    return selectedModelRef;
  }
  return resolved?.ref ?? selectedModelRef;
}

export function createLlmTaskTool(api: OpenClawPluginApi) {
  return {
    ...llmTaskToolDefinition,

    async execute(_id: string, args: unknown, signal?: AbortSignal) {
      const params = args as Record<string, unknown>;
      const prompt = typeof params.prompt === "string" ? params.prompt : "";
      if (!prompt.trim()) {
        throw new Error("prompt required");
      }

      const pluginCfg = api.pluginConfig ?? {};

      const defaultsModel = api.config?.agents?.defaults?.model;
      const primary =
        typeof defaultsModel === "string"
          ? normalizeOptionalString(defaultsModel)
          : normalizeOptionalString(defaultsModel?.primary);
      const primaryProvider = typeof primary === "string" ? primary.split("/")[0] : undefined;
      const primaryModel =
        typeof primary === "string" ? primary.split("/").slice(1).join("/") : undefined;

      const requestProvider = normalizeOptionalString(params.provider);
      const configuredProvider = normalizeOptionalString(pluginCfg.defaultProvider);
      const requestModel = normalizeOptionalString(params.model);
      const configuredModel = normalizeOptionalString(pluginCfg.defaultModel);
      const requestedProvider =
        requestProvider || configuredProvider || primaryProvider || undefined;
      const rawModel = requestModel || configuredModel || primaryModel || undefined;
      const hasModelOverride = Boolean(
        requestProvider || configuredProvider || requestModel || configuredModel,
      );
      const { provider, model } = resolveLlmTaskModelRef({
        api,
        provider: requestedProvider,
        rawModel,
        preserveProvider: Boolean(requestProvider || (!requestModel && configuredProvider)),
      });

      const authProfileId =
        normalizeOptionalString(params.authProfileId) ??
        normalizeOptionalString(pluginCfg.defaultAuthProfileId);

      const providerId = provider?.trim();
      const modelId = model?.trim();
      if (!providerId || !modelId) {
        throw new Error(
          `provider/model could not be resolved (provider=${provider ?? ""}, model=${model ?? ""})`,
        );
      }

      const thinkingRaw = readNonBlankString(params.thinking);
      const thinkLevel = thinkingRaw
        ? api.runtime.agent.normalizeThinkingLevel(thinkingRaw)
        : undefined;
      if (thinkingRaw && !thinkLevel) {
        throw new Error(`Invalid thinking level "${thinkingRaw}".`);
      }

      const timeoutMs =
        readPositiveIntegerParam(params, "timeoutMs") ??
        asPositiveSafeInteger(pluginCfg.timeoutMs) ??
        30_000;

      const temperature = readFiniteNumberParam(params, "temperature");
      const maxTokens =
        readPositiveIntegerParam(params, "maxTokens") ?? asPositiveSafeInteger(pluginCfg.maxTokens);

      const input = params.input;
      let inputJson: string;
      try {
        inputJson = JSON.stringify(input ?? null, null, 2);
      } catch {
        throw new Error("input must be JSON-serializable");
      }

      const system = [
        "You are a JSON-only function.",
        "Return ONLY a valid JSON value.",
        "Do not wrap in markdown fences.",
        "Do not include commentary.",
        "Do not call tools.",
      ].join(" ");

      const result = await api.runtime.llm.complete({
        messages: [
          {
            role: "user",
            content: `TASK:\n${prompt}\n\nINPUT_JSON:\n${inputJson}\n`,
          },
        ],
        systemPrompt: system,
        model: hasModelOverride ? `${providerId}/${modelId}` : undefined,
        reasoning: thinkLevel,
        maxTokens,
        temperature,
        signal,
        purpose: "llm-task",
        execution: {
          mode: "isolated-agent-runtime",
          authProfileId,
          timeoutMs,
        },
      });

      const raw = stripCodeFences(result.text);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("LLM returned invalid JSON");
      }

      const schema = params.schema;
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        const validation = validateJsonSchemaValue({
          schema: schema as JsonSchemaObject,
          cacheKey: "llm-task.result",
          value: parsed,
          cache: false,
        });
        if (!validation.ok) {
          const msg = validation.errors.map((error) => error.text).join("; ") || "invalid";
          throw new Error(`LLM JSON did not match schema: ${msg}`);
        }
      }

      return textResult(JSON.stringify(parsed, null, 2), {
        json: parsed,
        provider: result.provider,
        model: result.model,
      });
    },
  } satisfies AnyAgentTool;
}

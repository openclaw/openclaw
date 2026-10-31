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

      const defaultsModel = api.config.agents?.defaults?.model;
      const primary =
        typeof defaultsModel === "string"
          ? normalizeOptionalString(defaultsModel)
          : normalizeOptionalString(defaultsModel?.primary);
      const primaryProvider = primary?.split("/")[0];
      const primaryModel = primary?.split("/").slice(1).join("/");

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
      const defaultProvider =
        normalizeOptionalString(requestedProvider) ??
        normalizeOptionalString(api.runtime.agent.defaults.provider);
      const normalizedModel = normalizeOptionalString(rawModel);
      const providerPrefix = requestedProvider?.trim();
      let selectedModelRef = {
        provider: requestedProvider,
        model:
          providerPrefix && normalizedModel?.startsWith(`${providerPrefix}/`)
            ? normalizedModel.slice(providerPrefix.length + 1)
            : normalizedModel,
      };
      if (normalizedModel && defaultProvider) {
        const cfg = api.config;
        const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider });
        const resolved = resolveModelRefFromString({
          cfg,
          raw: normalizedModel,
          defaultProvider,
          aliasIndex,
        });
        // Selected providers own nested model IDs, but configured aliases still own their target.
        if (!(requestProvider || (!requestModel && configuredProvider)) || resolved?.alias) {
          selectedModelRef = resolved?.ref ?? selectedModelRef;
        }
      }
      const { provider, model } = selectedModelRef;

      const authProfileId =
        normalizeOptionalString(params.authProfileId) ??
        normalizeOptionalString(pluginCfg.defaultAuthProfileId);

      const providerId = provider?.trim();
      const modelId = model?.trim();
      // Without an override, the completion runtime owns default model selection.
      if (hasModelOverride && (!providerId || !modelId)) {
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
      const outputSchema =
        params.schema && typeof params.schema === "object" && !Array.isArray(params.schema)
          ? (params.schema as JsonSchemaObject)
          : undefined;

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
        ...(outputSchema ? { outputSchema } : {}),
        execution: {
          mode: "isolated-agent-runtime",
          authProfileId,
          timeoutMs,
        },
      });

      const trimmed = result.text.trim();
      const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
      const raw = match ? (match[1] ?? "").trim() : trimmed;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        throw new Error("LLM returned invalid JSON");
      }

      if (outputSchema) {
        const validation = validateJsonSchemaValue({
          schema: outputSchema,
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

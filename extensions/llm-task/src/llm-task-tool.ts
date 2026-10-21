import { buildModelAliasIndex, resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import { runTasksWithConcurrency } from "openclaw/plugin-sdk/concurrency-runtime";
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

class LlmTaskOutputError extends Error {
  constructor(
    readonly code: "invalid_json" | "schema_mismatch",
    message: string,
  ) {
    super(message);
  }
}

function serializeInput(input: unknown): string {
  try {
    const json = JSON.stringify(input ?? null, null, 2);
    if (json === undefined) {
      throw new Error("unsupported input");
    }
    return json;
  } catch {
    throw new Error("input must be JSON-serializable");
  }
}

function readBatch(params: Record<string, unknown>) {
  if (params.batch === undefined || params.batch === null) {
    return undefined;
  }
  if (params.input !== undefined && params.input !== null) {
    throw new Error("batch and input cannot be combined");
  }
  const batch = params.batch;
  if (!batch || typeof batch !== "object" || Array.isArray(batch)) {
    throw new Error("batch must contain items");
  }
  // SAFETY: The boundary above rejects null, arrays, and non-object batch values.
  const batchParams = batch as Record<string, unknown>;
  const { items } = batchParams;
  const concurrency = batchParams.concurrency ?? 2;
  if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
    throw new Error("batch.items must contain 1 to 20 items");
  }
  if (
    typeof concurrency !== "number" ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 4
  ) {
    throw new Error("batch.concurrency must be an integer from 1 to 4");
  }
  const ids = new Set<string>();
  let bytes = 0;
  const inputs = items.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("each batch item must contain id and input");
    }
    // SAFETY: The boundary above admits only non-null, non-array objects.
    const entry = item as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== "string" || !id.trim() || id.length > 64 || ids.has(id)) {
      throw new Error("batch item IDs must be unique nonblank strings of at most 64 characters");
    }
    if (!Object.hasOwn(entry, "input")) {
      throw new Error("each batch item must contain input");
    }
    ids.add(id);
    const inputJson = serializeInput(entry.input);
    bytes += Buffer.byteLength(inputJson, "utf8");
    return { id, inputJson };
  });
  if (bytes > 256 * 1024) {
    throw new Error("serialized batch inputs must not exceed 256 KiB");
  }
  return { inputs, concurrency };
}

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
  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider });
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

      const batch = readBatch(params);
      if (batch && timeoutMs > 2_147_483_647) {
        throw new Error("batch timeoutMs must not exceed 2147483647");
      }
      const schema = params.schema;
      // Reject malformed batch schemas before buying any inference. A value mismatch is expected here.
      if (batch && schema && typeof schema === "object" && !Array.isArray(schema)) {
        // SAFETY: The validator owns schema-shape validation; this admits JSON objects, not trusted schemas.
        validateJsonSchemaValue({ schema: schema as JsonSchemaObject, value: null, cache: false });
      }

      const system = [
        "You are a JSON-only function.",
        "Return ONLY a valid JSON value.",
        "Do not wrap in markdown fences.",
        "Do not include commentary.",
        "Do not call tools.",
      ].join(" ");

      const completeJson = async (
        inputJson: string,
        runSignal: AbortSignal | undefined,
        runTimeoutMs: number,
      ) => {
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
          signal: runSignal,
          purpose: "llm-task",
          execution: {
            mode: "isolated-agent-runtime",
            authProfileId,
            timeoutMs: runTimeoutMs,
          },
        });

        const raw = stripCodeFences(result.text);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new LlmTaskOutputError("invalid_json", "LLM returned invalid JSON");
        }

        if (schema && typeof schema === "object" && !Array.isArray(schema)) {
          const validation = validateJsonSchemaValue({
            schema: schema as JsonSchemaObject,
            cacheKey: "llm-task.result",
            value: parsed,
            cache: false,
          });
          if (!validation.ok) {
            const msg = validation.errors.map((error) => error.text).join("; ") || "invalid";
            throw new LlmTaskOutputError(
              "schema_mismatch",
              `LLM JSON did not match schema: ${msg}`,
            );
          }
        }

        return {
          json: parsed,
          provider: result.provider,
          model: result.model,
        };
      };

      if (!batch) {
        const result = await completeJson(serializeInput(params.input), signal, timeoutMs);
        return textResult(JSON.stringify(result.json, null, 2), result);
      }

      type ItemResult =
        | { id: string; status: "ok"; json: unknown; provider: string; model: string }
        | {
            id: string;
            status: "error";
            error: "invalid_json" | "schema_mismatch" | "completion_failed";
          }
        | { id: string; status: "cancelled" | "not_started" };
      const deadline = new AbortController();
      const batchSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
      const expiresAt = Date.now() + timeoutMs;
      const timer = setTimeout(() => deadline.abort(), timeoutMs);
      const isBatchAborted = () => {
        // Settlement can reach the deadline before its timer callback gets an event-loop turn.
        if (Date.now() >= expiresAt) {
          deadline.abort();
        }
        return batchSignal.aborted;
      };
      const tasks = batch.inputs.map(({ id, inputJson }) => async (): Promise<ItemResult> => {
        const remainingMs = expiresAt - Date.now();
        if (isBatchAborted()) {
          return { id, status: "not_started" };
        }
        try {
          const result = await completeJson(inputJson, batchSignal, remainingMs);
          return isBatchAborted() ? { id, status: "cancelled" } : { id, status: "ok", ...result };
        } catch (error) {
          // Provider errors can contain credentials or echoed input. Only stable categories leave this boundary.
          return isBatchAborted()
            ? { id, status: "cancelled" }
            : {
                id,
                status: "error",
                error: error instanceof LlmTaskOutputError ? error.code : "completion_failed",
              };
        }
      });
      let results: ItemResult[];
      try {
        ({ results } = await runTasksWithConcurrency({ tasks, limit: batch.concurrency }));
      } finally {
        clearTimeout(timer);
      }
      const output = {
        status: signal?.aborted ? "cancelled" : deadline.signal.aborted ? "timed_out" : "completed",
        results,
      };
      return textResult(JSON.stringify(output, null, 2), { json: output });
    },
  } satisfies AnyAgentTool;
}

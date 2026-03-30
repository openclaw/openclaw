import { Type } from "@sinclair/typebox";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
import {
  jsonResult,
  readConfiguredSecretString,
  readProviderEnvValue,
  readStringParam,
  resolveProviderWebSearchPluginConfig,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildXaiCodeExecutionPayload,
  requestXaiCodeExecution,
  resolveXaiCodeExecutionMaxTurns,
  resolveXaiCodeExecutionModel,
} from "./src/code-execution-shared.js";

type XaiPluginConfig = NonNullable<
  NonNullable<OpenClawConfig["plugins"]>["entries"]
>["xai"] extends {
  config?: infer Config;
}
  ? Config
  : undefined;

type CodeExecutionConfig = {
  enabled?: boolean;
  model?: string;
  maxTurns?: number;
  timeoutSeconds?: number;
};

function readCodeExecutionConfigRecord(
  config?: CodeExecutionConfig,
): Record<string, unknown> | undefined {
  return config && typeof config === "object" ? (config as Record<string, unknown>) : undefined;
}

function readLegacyGrokApiKey(cfg?: OpenClawConfig): string | undefined {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") {
    return undefined;
  }
  const grok = (search as Record<string, unknown>).grok;
  return readConfiguredSecretString(
    grok && typeof grok === "object" ? (grok as Record<string, unknown>).apiKey : undefined,
    "tools.web.search.grok.apiKey",
  );
}

function readPluginCodeExecutionConfig(cfg?: OpenClawConfig): CodeExecutionConfig | undefined {
  const entries = cfg?.plugins?.entries;
  if (!entries || typeof entries !== "object") {
    return undefined;
  }
  const xaiEntry = (entries as Record<string, unknown>).xai;
  if (!xaiEntry || typeof xaiEntry !== "object") {
    return undefined;
  }
  const config = (xaiEntry as Record<string, unknown>).config;
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const codeExecution = (config as Record<string, unknown>).codeExecution;
  if (!codeExecution || typeof codeExecution !== "object") {
    return undefined;
  }
  return codeExecution as CodeExecutionConfig;
}

function resolveFallbackXaiApiKey(cfg?: OpenClawConfig): string | undefined {
  return (
    readConfiguredSecretString(
      resolveProviderWebSearchPluginConfig(cfg as Record<string, unknown> | undefined, "xai")
        ?.apiKey,
      "plugins.entries.xai.config.webSearch.apiKey",
    ) ?? readLegacyGrokApiKey(cfg)
  );
}

function resolveCodeExecutionEnabled(params: {
  sourceConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  config?: CodeExecutionConfig;
}): boolean {
  if (readCodeExecutionConfigRecord(params.config)?.enabled === false) {
    return false;
  }
  return Boolean(
    resolveFallbackXaiApiKey(params.runtimeConfig) ??
    resolveFallbackXaiApiKey(params.sourceConfig) ??
    readProviderEnvValue(["XAI_API_KEY"]),
  );
}

export function createCodeExecutionTool(options?: {
  config?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig | null;
}) {
  const runtimeConfig = options?.runtimeConfig ?? getRuntimeConfigSnapshot();
  const codeExecutionConfig =
    readPluginCodeExecutionConfig(runtimeConfig ?? undefined) ??
    readPluginCodeExecutionConfig(options?.config);
  if (
    !resolveCodeExecutionEnabled({
      sourceConfig: options?.config,
      runtimeConfig: runtimeConfig ?? undefined,
      config: codeExecutionConfig,
    })
  ) {
    return null;
  }

  return {
    label: "Code Execution",
    name: "code_execution",
    description:
      "Run sandboxed Python analysis with xAI. Use for calculations, tabulation, summaries, and chart-style analysis without local machine access.",
    parameters: Type.Object({
      task: Type.String({
        description:
          "The full analysis task for xAI's remote Python sandbox. Include any data to analyze directly in the task.",
      }),
    }),
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const apiKey =
        resolveFallbackXaiApiKey(runtimeConfig ?? undefined) ??
        resolveFallbackXaiApiKey(options?.config) ??
        readProviderEnvValue(["XAI_API_KEY"]);
      if (!apiKey) {
        return jsonResult({
          error: "missing_xai_api_key",
          message:
            "code_execution needs an xAI API key. Set XAI_API_KEY in the Gateway environment, or configure plugins.entries.xai.config.webSearch.apiKey.",
          docs: "https://docs.openclaw.ai/tools/code-execution",
        });
      }

      const task = readStringParam(args, "task", { required: true });
      const codeExecutionConfigRecord = readCodeExecutionConfigRecord(codeExecutionConfig);
      const model = resolveXaiCodeExecutionModel(codeExecutionConfigRecord);
      const maxTurns = resolveXaiCodeExecutionMaxTurns(codeExecutionConfigRecord);
      const timeoutSeconds =
        typeof codeExecutionConfigRecord?.timeoutSeconds === "number" &&
        Number.isFinite(codeExecutionConfigRecord.timeoutSeconds)
          ? codeExecutionConfigRecord.timeoutSeconds
          : 30;
      const startedAt = Date.now();
      const result = await requestXaiCodeExecution({
        apiKey,
        model,
        timeoutSeconds,
        maxTurns,
        task,
      });
      return jsonResult(
        buildXaiCodeExecutionPayload({
          task,
          model,
          tookMs: Date.now() - startedAt,
          content: result.content,
          citations: result.citations,
          usedCodeExecution: result.usedCodeExecution,
          outputTypes: result.outputTypes,
        }),
      );
    },
  };
}

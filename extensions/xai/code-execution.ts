import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/provider-web-search";
import { getRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  buildMissingCodeExecutionApiKeyPayload,
  createCodeExecutionToolDefinition,
} from "./code-execution-tool-shared.js";
import { XAI_DEFAULT_MODEL_ID } from "./model-definitions.js";
import {
  readPluginCodeExecutionConfig,
  resolveCodeExecutionEnabled,
} from "./src/code-execution-config.js";
import {
  requestXaiResponsesTool,
  resolveXaiToolDefaultReasoningEffort,
  requireXaiResponseTextAndCitations,
  XAI_RESPONSES_ENDPOINT,
} from "./src/responses-tool-shared.js";
import { resolveXaiToolApiKeyWithAuth, type XaiToolAuthContext } from "./src/tool-auth-shared.js";
import {
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./src/tool-config-shared.js";

export function createCodeExecutionTool(options?: {
  config?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig | null;
  auth?: XaiToolAuthContext;
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
      auth: options?.auth,
    })
  ) {
    return null;
  }

  return createCodeExecutionToolDefinition(
    async (_toolCallId: string, args: Record<string, unknown>) => {
      const apiKey = await resolveXaiToolApiKeyWithAuth({
        runtimeConfig: runtimeConfig ?? undefined,
        sourceConfig: options?.config,
        auth: options?.auth,
      });
      if (!apiKey) {
        return jsonResult(buildMissingCodeExecutionApiKeyPayload());
      }

      const task = readStringParam(args, "task", { required: true });
      const model = resolveNormalizedXaiToolModel({
        config: codeExecutionConfig,
        defaultModel: XAI_DEFAULT_MODEL_ID,
      });
      const maxTurns = resolvePositiveIntegerToolConfig(codeExecutionConfig, "maxTurns");
      const timeoutSeconds =
        typeof codeExecutionConfig?.timeoutSeconds === "number" &&
        Number.isFinite(codeExecutionConfig.timeoutSeconds)
          ? codeExecutionConfig.timeoutSeconds
          : 30;
      const startedAt = Date.now();
      const result = await requestXaiResponsesTool(
        {
          apiKey,
          model,
          timeoutSeconds,
          maxTurns,
          endpoint: XAI_RESPONSES_ENDPOINT,
          inputText: task,
          tools: [{ type: "code_interpreter" }],
          reasoningEffort: resolveXaiToolDefaultReasoningEffort(model, "low"),
          errorLabel: "xAI code execution failed",
        },
        (data) => {
          const { content, citations } = requireXaiResponseTextAndCitations(
            data,
            "xAI code execution failed",
          );
          const outputTypes = Array.isArray(data.output)
            ? [
                ...new Set(
                  data.output
                    .map((entry) => entry?.type)
                    .filter((value): value is string => Boolean(value)),
                ),
              ]
            : [];
          return {
            content,
            citations,
            usedCodeExecution: outputTypes.includes("code_interpreter_call"),
            outputTypes,
          };
        },
      );
      return jsonResult({
        task,
        provider: "xai",
        model,
        tookMs: Date.now() - startedAt,
        ...result,
      });
    },
  );
}

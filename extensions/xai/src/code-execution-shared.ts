import { XAI_DEFAULT_MODEL_ID } from "../model-definitions.js";
import {
  requestXaiResponsesTool,
  resolveXaiToolDefaultReasoningEffort,
  requireXaiResponseTextAndCitations,
  XAI_RESPONSES_ENDPOINT,
} from "./responses-tool-shared.js";
import {
  resolveNormalizedXaiToolModel,
  resolvePositiveIntegerToolConfig,
} from "./tool-config-shared.js";

type XaiCodeExecutionResult = {
  content: string;
  citations: string[];
  usedCodeExecution: boolean;
  outputTypes: string[];
};

export function resolveXaiCodeExecutionModel(config?: Record<string, unknown>): string {
  return resolveNormalizedXaiToolModel({
    config,
    defaultModel: XAI_DEFAULT_MODEL_ID,
  });
}

export function resolveXaiCodeExecutionMaxTurns(
  config?: Record<string, unknown>,
): number | undefined {
  return resolvePositiveIntegerToolConfig(config, "maxTurns");
}

export async function requestXaiCodeExecution(params: {
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  maxTurns?: number;
  task: string;
}): Promise<XaiCodeExecutionResult> {
  return await requestXaiResponsesTool(
    {
      ...params,
      endpoint: XAI_RESPONSES_ENDPOINT,
      inputText: params.task,
      tools: [{ type: "code_interpreter" }],
      reasoningEffort: resolveXaiToolDefaultReasoningEffort(params.model, "low"),
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
}

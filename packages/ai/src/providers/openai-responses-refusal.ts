import type { AssistantMessageDiagnostic } from "../types.js";

type OpenAIResponsesRefusalOutput = {
  stopReason: string;
  errorMessage?: string;
  diagnostics?: AssistantMessageDiagnostic[];
};

function readNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function formatOpenAIResponsesRefusalMessage(explanation: string | null): string {
  return explanation ? `OpenAI refusal: ${explanation}` : "OpenAI refusal.";
}

export function applyOpenAIResponsesRefusal(
  output: OpenAIResponsesRefusalOutput,
  refusal: unknown,
  provider: string,
): void {
  const explanation = readNullableString(refusal);
  output.stopReason = "error";
  output.errorMessage = formatOpenAIResponsesRefusalMessage(explanation);
  output.diagnostics = [
    ...(output.diagnostics ?? []),
    {
      type: "provider_refusal",
      timestamp: Date.now(),
      details: {
        provider,
        explanation,
      },
    },
  ];
}

import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type { AssistantMessageDiagnostic } from "../types.js";

type AnthropicRefusalOutput = {
  stopReason: string;
  errorMessage?: string;
  diagnostics?: AssistantMessageDiagnostic[];
};

export function applyAnthropicRefusal(
  output: AnthropicRefusalOutput,
  stopDetails: unknown,
  provider: string,
): void {
  const record = asOptionalObjectRecord(stopDetails);
  const details = {
    category: normalizeNullableString(record?.category),
    explanation: normalizeNullableString(record?.explanation),
  };
  const category = details.category ? ` (category: ${details.category})` : "";
  const explanation = details.explanation ? `: ${details.explanation}` : ".";
  output.stopReason = "error";
  output.errorMessage = `Anthropic refusal${category}${explanation}`;
  output.diagnostics = [
    ...(output.diagnostics ?? []),
    {
      type: "provider_refusal",
      timestamp: Date.now(),
      details: {
        provider,
        category: details.category,
        explanation: details.explanation,
      },
    },
  ];
}

import { runAgentHarnessToolInvocation } from "openclaw/plugin-sdk/agent-harness-tool-runtime";
import {
  runWithToolResultDeliveryProjection,
  toolResultFitsBudget,
} from "openclaw/plugin-sdk/text-utility-runtime";
import type { CodexDynamicToolRuntimeResponse } from "./dynamic-tool-response-state.js";

/** Fit skill pages to the same weighted budget used by the Codex result projection. */
export function runCodexToolInvocation(
  maxChars: number,
  invocation: Parameters<typeof runAgentHarnessToolInvocation<CodexDynamicToolRuntimeResponse>>[0],
): Promise<CodexDynamicToolRuntimeResponse> {
  return runWithToolResultDeliveryProjection(
    (result) =>
      toolResultFitsBudget(result.content.map((part) => part.text).join(""), {
        maxChars,
        maxContextChars: Number.MAX_SAFE_INTEGER,
      }),
    () => runAgentHarnessToolInvocation(invocation),
  );
}

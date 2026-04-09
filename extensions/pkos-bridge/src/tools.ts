import type { ResolvedPkosBridgeConfig } from "./config.js";
import {
  PrepareTaskHandoffToolSchema,
  PkosBridgeStatusToolSchema,
  SubmitTraceBundleToolSchema,
} from "./contracts.js";
import { buildBridgeStatusText, buildTaskHandoffDraft, buildTraceBundleReceipt } from "./shared.js";

function textResult(text: string) {
  return { content: [{ type: "text", text }] };
}

function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function createPkosBridgeStatusTool(config: ResolvedPkosBridgeConfig) {
  return {
    name: "pkos_bridge_status",
    label: "PKOS Bridge Status",
    description: "Show the current PKOS bridge scaffold status and configured roots.",
    parameters: PkosBridgeStatusToolSchema,
    async execute() {
      return textResult(buildBridgeStatusText(config));
    },
  };
}

export function createPrepareTaskHandoffTool(_config: ResolvedPkosBridgeConfig) {
  return {
    name: "pkos_bridge_prepare_task_handoff",
    label: "Prepare Task Handoff",
    description: "Build the MVP task handoff envelope from OpenClaw to Workbench.",
    parameters: PrepareTaskHandoffToolSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      return jsonResult(
        buildTaskHandoffDraft({
          taskId: String(rawParams.task_id ?? ""),
          goal: String(rawParams.goal ?? ""),
          expectedOutput: String(rawParams.expected_output ?? ""),
          constraints: Array.isArray(rawParams.constraints)
            ? rawParams.constraints.map((item) => String(item))
            : [],
          handoffBackWhen: String(rawParams.handoff_back_when ?? ""),
        }),
      );
    },
  };
}

export function createSubmitTraceBundleTool(_config: ResolvedPkosBridgeConfig) {
  return {
    name: "pkos_bridge_submit_trace_bundle",
    label: "Submit Trace Bundle",
    description: "Accept a frozen trace bundle placeholder and return the review intake receipt.",
    parameters: SubmitTraceBundleToolSchema,
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      return jsonResult(
        buildTraceBundleReceipt({
          runId: String(rawParams.run_id ?? ""),
          taskId: typeof rawParams.task_id === "string" ? rawParams.task_id : undefined,
          traceBundlePath: String(rawParams.trace_bundle_path ?? ""),
          summary: typeof rawParams.summary === "string" ? rawParams.summary : undefined,
        }),
      );
    },
  };
}

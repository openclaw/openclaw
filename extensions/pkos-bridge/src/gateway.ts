import type { ResolvedPkosBridgeConfig } from "./config.js";
import { buildBridgeStatusText, buildTaskHandoffDraft, buildTraceBundleReceipt } from "./shared.js";

export function createPkosBridgeStatusGatewayMethod(config: ResolvedPkosBridgeConfig) {
  return async () => ({
    ok: true,
    text: buildBridgeStatusText(config),
  });
}

export function createPrepareTaskHandoffGatewayMethod(_config: ResolvedPkosBridgeConfig) {
  return async (params: Record<string, unknown>) => ({
    ok: true,
    handoff: buildTaskHandoffDraft({
      taskId: String(params.task_id ?? ""),
      goal: String(params.goal ?? ""),
      expectedOutput: String(params.expected_output ?? ""),
      constraints: Array.isArray(params.constraints) ? params.constraints.map(String) : [],
      handoffBackWhen: String(params.handoff_back_when ?? ""),
    }),
  });
}

export function createSubmitTraceBundleGatewayMethod(_config: ResolvedPkosBridgeConfig) {
  return async (params: Record<string, unknown>) => ({
    ok: true,
    receipt: buildTraceBundleReceipt({
      runId: String(params.run_id ?? ""),
      taskId: typeof params.task_id === "string" ? params.task_id : undefined,
      traceBundlePath: String(params.trace_bundle_path ?? ""),
      summary: typeof params.summary === "string" ? params.summary : undefined,
    }),
  });
}

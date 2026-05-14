import type { OpenClawPluginApi } from "../api.js";
import { buildRunPreview } from "./preview.js";
import type { SpecRecord, SpecRunRecord } from "./types.js";

export function createPreviewRun(params: {
  api: Pick<OpenClawPluginApi, "runtime" | "config">;
  spec: SpecRecord;
  sessionKey?: string;
}): SpecRunRecord {
  const preview = buildRunPreview(params.spec);
  const runId = `spec-run-${Date.now()}`;
  const createdAt = new Date().toISOString();
  const sessionKey = params.sessionKey?.trim();
  let flowId: string | undefined;

  if (sessionKey) {
    try {
      const flow = params.api.runtime.tasks.managedFlows.bindSession({ sessionKey }).createManaged({
        controllerId: "spec-center",
        goal: `Preview Spec Center run for ${params.spec.id}`,
        status: "queued",
        currentStep: preview.waves[0]?.steps[0] ?? null,
        stateJson: {
          specId: params.spec.id,
          previewOnly: true,
          waves: preview.waves,
        },
      });
      flowId = flow.flowId;
    } catch {
      flowId = undefined;
    }
  }

  return {
    runId,
    specId: params.spec.id,
    status: "previewed",
    createdAt,
    ...(flowId ? { flowId } : {}),
    preview,
  };
}

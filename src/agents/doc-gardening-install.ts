import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { DocGardeningSuggestion } from "./doc-gardening.js";

type GatewayCallLike = typeof callGateway;

export type DocGardeningInstallResult = {
  action: "created" | "updated";
  jobId: string;
  name: string;
  scheduleExpr: string;
  sessionTarget: "isolated";
  lightContext: boolean;
};

const MANAGED_DOC_GARDEN_MARKER = "[openclaw:doc-garden]";

function resolveDocGardenDescription(workspaceDir?: string): string {
  const workspaceLabel = workspaceDir?.trim() || "(unknown-workspace)";
  return `${MANAGED_DOC_GARDEN_MARKER} workspace=${workspaceLabel}`;
}

function buildGatewayCallParams(method: string, params?: unknown) {
  return {
    method,
    params,
    clientName: GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT,
    clientDisplayName: "Chat /context",
    mode: GATEWAY_CLIENT_MODES.BACKEND,
  } as const;
}

function buildDocGardenJobParams(params: {
  suggestion: DocGardeningSuggestion;
  workspaceDir?: string;
  sessionKey?: string;
  model?: string;
}) {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return {
    name: params.suggestion.name,
    description: resolveDocGardenDescription(params.workspaceDir),
    enabled: true,
    sessionKey: params.sessionKey,
    schedule: {
      kind: "cron" as const,
      expr: params.suggestion.schedule.expr,
      ...(timezone ? { tz: timezone } : {}),
    },
    sessionTarget: params.suggestion.sessionTarget,
    wakeMode: "now" as const,
    payload: {
      kind: "agentTurn" as const,
      message: params.suggestion.message,
      ...(params.model ? { model: params.model } : {}),
      lightContext: params.suggestion.lightContext,
    },
    delivery: {
      mode: "announce" as const,
      channel: "last" as const,
    },
  };
}

export async function installDocGardeningSuggestion(params: {
  suggestion: DocGardeningSuggestion;
  workspaceDir?: string;
  sessionKey?: string;
  model?: string;
  gatewayCall?: GatewayCallLike;
}): Promise<DocGardeningInstallResult> {
  const gatewayCall = params.gatewayCall ?? callGateway;
  const desiredJob = buildDocGardenJobParams(params);
  const listResponse = await gatewayCall(
    buildGatewayCallParams("cron.list", {
      includeDisabled: true,
      limit: 200,
    }),
  );

  const existing = Array.isArray(listResponse.jobs)
    ? listResponse.jobs.find(
        (job) =>
          typeof job.id === "string" &&
          typeof job.description === "string" &&
          job.description === desiredJob.description,
      )
    : undefined;

  if (existing?.id) {
    const updated = await gatewayCall(
      buildGatewayCallParams("cron.update", {
        id: existing.id,
        patch: desiredJob,
      }),
    );
    const updatedJobId = typeof updated.id === "string" ? updated.id : existing.id;
    const updatedName = typeof updated.name === "string" ? updated.name : desiredJob.name;
    return {
      action: "updated",
      jobId: updatedJobId,
      name: updatedName,
      scheduleExpr: desiredJob.schedule.expr,
      sessionTarget: desiredJob.sessionTarget,
      lightContext: desiredJob.payload.lightContext,
    };
  }

  const created = await gatewayCall(buildGatewayCallParams("cron.add", desiredJob));
  const createdJobId = typeof created.id === "string" ? created.id : "";
  const createdName = typeof created.name === "string" ? created.name : desiredJob.name;
  return {
    action: "created",
    jobId: createdJobId,
    name: createdName,
    scheduleExpr: desiredJob.schedule.expr,
    sessionTarget: desiredJob.sessionTarget,
    lightContext: desiredJob.payload.lightContext,
  };
}

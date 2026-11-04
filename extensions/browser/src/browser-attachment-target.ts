import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { readStringParam } from "openclaw/plugin-sdk/channel-actions";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function readBrowserAttachmentTarget(args: unknown, bound: boolean): string | undefined {
  const params = asNullableRecord(args) ?? {};
  const environmentId = readStringParam(params, "environmentId");
  if (params.environmentId !== undefined && !environmentId) {
    throw new Error("environmentId must be nonempty");
  }
  if (
    environmentId &&
    (bound ||
      params.target !== undefined ||
      params.node !== undefined ||
      params.browserTab !== undefined ||
      params.browserDashboard !== undefined ||
      params.dashboard !== undefined)
  ) {
    throw new Error("Choose an environmentId or another browser target, not both");
  }
  if (environmentId && params.action === "dashboard") {
    throw new Error("Attached browsers do not use Gateway dashboards");
  }
  return environmentId;
}
export function withBrowserAttachmentDetails(
  result: AgentToolResult<unknown>,
  environmentId: string,
): AgentToolResult<unknown> {
  const details = { ...asNullableRecord(result.details) };
  delete details.browserTab;
  delete details.browserDashboard;
  return { ...result, details: { ...details, environmentId } };
}

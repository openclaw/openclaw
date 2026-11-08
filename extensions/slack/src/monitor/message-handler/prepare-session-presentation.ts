import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackMonitorContext } from "../context.js";

export function resolveSlackGroupSessionSubject(params: {
  channelId: string;
  channelName?: string;
  workspaceId: string;
  installationIdentity?: SlackMonitorContext["installationIdentity"];
}): string {
  const channelName = normalizeOptionalString(params.channelName);
  const workspaceName = normalizeOptionalString(
    params.installationIdentity?.kind === "workspace" &&
      params.installationIdentity.teamId === params.workspaceId
      ? params.installationIdentity.teamName
      : undefined,
  );
  if (channelName && workspaceName) {
    return `${workspaceName} #${channelName}`;
  }
  return `Slack Channel (Workspace ID: ${params.workspaceId}, Channel ID: ${params.channelId})`;
}

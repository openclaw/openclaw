import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
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

export function resolveSlackConversationLink(params: {
  channelId: string;
  teamId?: string;
  slackApiUrl?: string;
  existingLink?: SessionEntry["conversationLink"];
}): SessionEntry["conversationLink"] {
  if (params.existingLink) {
    return params.existingLink;
  }
  const teamId = normalizeOptionalString(params.teamId);
  let apiHost = "";
  try {
    apiHost = params.slackApiUrl ? new URL(params.slackApiUrl).hostname.toLowerCase() : "";
  } catch {
    // Invalid or custom API roots use the public Slack redirect host.
  }
  // Slack documents app_redirect for opening a conversation. Its exact-message permalink
  // API is remote and optional, so session preparation must not wait on it.
  const host = apiHost === "slack-gov.com" ? "slack-gov.com" : "slack.com";
  const url = new URL(`https://${host}/app_redirect`);
  url.searchParams.set("channel", params.channelId);
  if (teamId) {
    url.searchParams.set("team", teamId);
  }
  return { url: url.href, label: "Slack" };
}

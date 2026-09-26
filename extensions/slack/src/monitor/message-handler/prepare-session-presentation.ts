import type { SessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createSlackLookupClient } from "../../client.js";
import { formatSlackError } from "../../errors.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";

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

export async function resolveSlackConversationLink(params: {
  ctx: SlackMonitorContext;
  eventScope?: SlackEventScope;
  channelId: string;
  messageTs?: string;
  threadId?: string;
  existingLink?: SessionEntry["conversationLink"];
}): Promise<SessionEntry["conversationLink"]> {
  if (params.existingLink) {
    return params.existingLink;
  }
  const client = params.eventScope?.client ?? params.ctx.app.client;
  const messageId = params.threadId ?? params.messageTs;
  if (!messageId || !client.token) {
    return undefined;
  }
  try {
    // Bound this optional lookup while preserving Bolt's event authorization and transport.
    const lookupClient = createSlackLookupClient(client.token, {
      fetch: params.ctx.app.webClientOptions?.fetch,
      slackApiUrl: client.slackApiUrl,
      teamId: params.eventScope?.teamId ?? params.ctx.teamId,
    });
    const result = await lookupClient.chat.getPermalink({
      channel: params.channelId,
      message_ts: messageId,
    });
    if (result.permalink) {
      const url = new URL(result.permalink);
      if (params.threadId) {
        // New roots may omit Slack's thread parameters; preserve the native thread destination.
        url.searchParams.set("thread_ts", params.threadId);
        url.searchParams.set("cid", params.channelId);
      }
      return {
        url: url.href,
        label: params.threadId ? "Slack Thread" : "Slack Message",
      };
    }
  } catch (error) {
    params.ctx.logger.warn(
      { error: formatSlackError(error), channelId: params.channelId },
      "Slack conversation link unavailable",
    );
  }
  return undefined;
}

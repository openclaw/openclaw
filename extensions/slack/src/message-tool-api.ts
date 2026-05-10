import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";
import { Type, type TSchema } from "typebox";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { listSlackMessageActions } from "./message-actions.js";

const SLACK_MESSAGE_ID_ACTIONS = ["react", "reactions", "edit", "delete", "pin", "unpin"] as const;

function createSlackFileActionSchema(): Record<string, TSchema> {
  return {
    fileId: Type.Optional(
      Type.String({
        description:
          'Slack file id, starting with "F" (for example F0B0LTT8M36). Required for action="download-file". Read it from inbound Slack file metadata at event.files[].id. This is not the Slack message timestamp/messageId.',
      }),
    ),
  };
}

function createSlackMessageIdActionSchema(): Record<string, TSchema> {
  const description =
    'Slack message timestamp/message id (for example "1777423717.666499"). Used by react, reactions, edit, delete, pin, and unpin actions. Not used by download-file, which requires fileId from event.files[].id.';
  return {
    messageId: Type.Optional(Type.String({ description })),
    message_id: Type.Optional(Type.String({ description: `${description} Alias for messageId.` })),
  };
}

export function describeSlackMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const actions = listSlackMessageActions(cfg, accountId);
  const capabilities = new Set<"presentation">();
  const schema: ChannelMessageToolSchemaContribution[] = [];
  if (actions.includes("send")) {
    capabilities.add("presentation");
  }
  if (isSlackInteractiveRepliesEnabled({ cfg, accountId })) {
    capabilities.add("presentation");
  }
  if (actions.includes("download-file")) {
    schema.push({
      properties: createSlackFileActionSchema(),
      actions: ["download-file"],
    });
  }
  const messageIdActions: ChannelMessageActionName[] = [];
  for (const action of SLACK_MESSAGE_ID_ACTIONS) {
    if (actions.includes(action)) {
      messageIdActions.push(action);
    }
  }
  if (messageIdActions.length > 0) {
    schema.push({
      properties: createSlackMessageIdActionSchema(),
      actions: messageIdActions,
    });
  }
  return {
    actions,
    capabilities: Array.from(capabilities),
    schema: schema.length > 0 ? schema : null,
  };
}

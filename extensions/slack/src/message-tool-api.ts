import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";
import { Type } from "typebox";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { listSlackMessageActions } from "./message-actions.js";

/**
 * Tool-schema fragments contributed by the Slack plugin to the shared
 * `message` tool. The descriptions here are the *only* model-visible
 * documentation for these fields, so they need to be unambiguous.
 *
 * History: 2026-04-29 production incident (`marvin-production-381052`,
 * runId `911b8eff-3eb7-4f59-beaa-fdefe61f44b2`). Slack file uploads were
 * silently failing because the LLM was passing the Slack *message
 * timestamp* as `messageId` to `message(action="download-file")`. The
 * dispatcher requires `fileId` (the Slack `F…` id from `event.files[].id`),
 * not `messageId`. Without an explicit schema fragment for these fields,
 * the model only saw a generic stringly-typed pass-through and confused
 * the two. The descriptions below are tuned to make that confusion
 * impossible: every reference to either field reminds the reader which
 * actions need which value.
 */
function createSlackFileActionSchema(): Record<string, ReturnType<typeof Type.Optional>> {
  return {
    fileId: Type.Optional(
      Type.String({
        description:
          'Slack file id (starts with "F", e.g. F0B0LTT8M36). Required for action="download-file". Found in the inbound message envelope at event.files[].id. NOT the same thing as messageId / message timestamp; do not pass a numeric ts here.',
      }),
    ),
  };
}

function createSlackMessageIdSchema(): Record<string, ReturnType<typeof Type.Optional>> {
  return {
    messageId: Type.Optional(
      Type.String({
        description:
          'Slack message timestamp (e.g. "1777423717.666499"). Used by react / edit / delete / pin / reactions / unsend actions. NOT used by download-file — that action wants fileId (a Slack file id starting with "F"), not the message ts.',
      }),
    ),
    message_id: Type.Optional(
      Type.String({
        // Intentional snake_case alias for tool-schema discoverability in
        // LLMs that prefer snake_case keys.
        description:
          "snake_case alias of messageId. Slack message timestamp; used by react / edit / delete / pin / reactions / unsend. NOT used by download-file — that action wants fileId.",
      }),
    ),
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
  if (actions.includes("send")) {
    capabilities.add("presentation");
  }
  if (isSlackInteractiveRepliesEnabled({ cfg, accountId })) {
    capabilities.add("presentation");
  }

  // Schema fragments: only contribute the field descriptions for actions the
  // current account is actually allowed to invoke. This keeps unrelated
  // accounts' tool-schemas from gaining `fileId` documentation they don't
  // need, and lets cross-channel discovery hide the fragment cleanly.
  const schema: ChannelMessageToolSchemaContribution[] = [];
  if (actions.includes("download-file")) {
    schema.push({
      properties: createSlackFileActionSchema(),
      actions: ["download-file"],
    });
  }
  // messageId / message_id appear on enough actions that we declare them
  // whenever any of those actions is available. This also gives the LLM
  // a tool-schema cross-reference: even when it's invoking react / edit,
  // the description spells out that download-file does NOT use this field.
  const messageIdActions: ChannelMessageActionName[] = [];
  if (actions.includes("react")) messageIdActions.push("react");
  if (actions.includes("reactions")) messageIdActions.push("reactions");
  if (actions.includes("edit")) messageIdActions.push("edit");
  if (actions.includes("delete")) messageIdActions.push("delete");
  if (actions.includes("pin")) messageIdActions.push("pin");
  if (actions.includes("unpin")) messageIdActions.push("unpin");
  if (actions.includes("unsend")) messageIdActions.push("unsend");
  if (messageIdActions.length > 0) {
    schema.push({
      properties: createSlackMessageIdSchema(),
      actions: messageIdActions,
    });
  }

  return {
    actions,
    capabilities: Array.from(capabilities),
    schema: schema.length > 0 ? schema : null,
  };
}

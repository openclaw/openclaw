# Slack Block Kit Webhook Implementation Plan

## Overview
Add support for handling Block Kit interactive component callbacks (button clicks, etc.) when users interact with messages sent via OpenClaw.

## Current State
- ✅ Block Kit blocks can be SENT via `message` tool with `blocks` parameter
- ✅ Buttons render correctly in Slack
- ❌ Button clicks show warning icon (no handler registered)

## Implementation

### 1. New File: `src/slack/monitor/events/interactions.ts`

Handle `block_actions` events from Slack Bolt:

```typescript
import type { SlackActionMiddlewareArgs } from "@slack/bolt";
import type { SlackMonitorContext } from "../context.js";

export function registerSlackInteractionEvents(params: {
  ctx: SlackMonitorContext;
}) {
  const { ctx } = params;

  // Handle Block Kit button clicks and other interactions
  ctx.app.action(/^.*/, async (args: SlackActionMiddlewareArgs) => {
    const { ack, body, action, respond } = args;
    
    // Acknowledge the action immediately
    await ack();

    // Extract action details
    const actionId = action?.action_id;
    const blockId = action?.block_id;
    const value = action?.value;
    const userId = body.user?.id;
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts;
    
    // Log the interaction for debugging
    ctx.runtime.log?.(`slack:interaction action=${actionId} user=${userId} channel=${channelId}`);

    // Option 1: Send a system event to the agent
    // This allows the agent to respond to button clicks
    const sessionKey = ctx.resolveSlackSystemEventSessionKey({
      channelId: channelId ?? "",
      channelType: "channel",
    });
    
    enqueueSystemEvent(
      `Slack button clicked: ${actionId}`,
      {
        sessionKey,
        contextKey: `slack:interaction:${channelId}:${messageTs}:${actionId}`,
        metadata: {
          actionId,
          blockId,
          value,
          userId,
          channelId,
          messageTs,
        },
      }
    );

    // Option 2: Send an ephemeral confirmation
    // This gives immediate feedback to the user
    if (respond) {
      await respond({
        text: `Button "${actionId}" clicked!`,
        response_type: "ephemeral",
      });
    }
  });
}
```

### 2. Register in `src/slack/monitor/events.ts`

Add to `registerSlackMonitorEvents()`:

```typescript
import { registerSlackInteractionEvents } from "./events/interactions.js";

export function registerSlackMonitorEvents(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  handleSlackMessage: SlackMessageHandler;
}) {
  registerSlackMessageEvents({ ... });
  registerSlackReactionEvents({ ... });
  registerSlackMemberEvents({ ... });
  registerSlackChannelEvents({ ... });
  registerSlackPinEvents({ ... });
  registerSlackInteractionEvents({ ctx: params.ctx }); // NEW
}
```

### 3. Required Slack App Configuration

In your Slack App settings (api.slack.com/apps):

1. **Interactivity & Shortcuts** → Enable Interactivity
2. **Request URL** (for HTTP mode): `https://your-domain/slack/events`
3. **Subscribe to bot events**:
   - `block_actions` (already included via Bolt)

For Socket Mode (current setup), no additional URL configuration needed - Bolt handles it automatically.

### 4. Usage Example

```json
// Send a message with buttons
{
  "action": "send",
  "channel": "slack",
  "to": "channel:C123",
  "message": "Choose an option:",
  "blocks": [
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Option 1" },
          "action_id": "option_1_selected",
          "value": "opt1"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Option 2" },
          "action_id": "option_2_selected",
          "value": "opt2"
        }
      ]
    }
  ]
}
```

When a user clicks a button, the agent will receive a system event:
- Message: "Slack button clicked: option_1_selected"
- Metadata includes: actionId, value, userId, channelId, messageTs

## Scope Considerations

The warning icon appears because:
1. Slack sends the `block_actions` payload to the bot
2. Bolt receives it but no handler is registered
3. Slack shows the warning to indicate the action wasn't handled

After implementing this handler:
1. Bolt receives `block_actions` 
2. Handler acknowledges the action
3. No warning icon appears
4. Agent can respond via system event

## Testing

1. Send message with buttons using the `blocks` parameter
2. Click a button in Slack
3. Verify no warning icon appears
4. Check agent receives system event with button details
5. Agent can respond with a follow-up message

## Future Enhancements

- Support for select menus, date pickers, etc.
- Custom action routing based on action_id prefix
- Update original message on button click (using `body.message.ts`)
- Support for modal submissions (`view_submission`)

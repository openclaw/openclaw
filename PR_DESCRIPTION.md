# PR: Slack Search and Block Kit Support

## Summary
This PR adds three major features to OpenClaw's Slack integration:
1. **Message Search** - Search Slack messages using the `search.messages` API
2. **Block Kit Support** - Send interactive messages with buttons and components
3. **Interaction Handling** - Handle button clicks and send events to agents

## Changes

### 1. Message Search (`src/slack/actions.ts`, `src/agents/tools/slack-actions.ts`, `src/channels/plugins/slack.actions.ts`)
- Added `searchSlackMessages()` function using Slack's Web API
- Supports query, sort (timestamp/score), sort direction, count, and pagination
- **Requires user token** (bot tokens cannot use search API)
- Returns matches with message text, channel info, user, permalink, and timestamps

### 2. Block Kit Support (`src/slack/send.ts`, `src/slack/actions.ts`, `src/agents/tools/slack-actions.ts`, `src/channels/plugins/slack.actions.ts`)
- Added `blocks` parameter to `sendMessageSlack()` for Block Kit JSON
- Blocks are passed to Slack's `chat.postMessage` API
- Supports buttons, sections, actions, and all Block Kit components
- Falls back to text for multi-chunk messages (blocks only on first message)

### 3. Interaction Handling (`src/slack/monitor/events/interactions.ts`, `src/slack/monitor/events.ts`)
- New handler for `block_actions` events from Slack Bolt
- Acknowledges button clicks immediately (prevents warning icon)
- Sends ephemeral confirmation to user
- Enqueues system event so agents can respond to interactions

## Usage Examples

### Search Messages
```json
{
  "action": "search",
  "channel": "slack",
  "query": "from:@user in:#channel keyword",
  "sort": "timestamp",
  "sortDir": "desc",
  "count": 20
}
```

### Send Message with Button
```json
{
  "action": "send",
  "channel": "slack",
  "to": "channel:C123",
  "message": "Choose an option:",
  "blocks": [
    {
      "type": "section",
      "text": { "type": "mrkdwn", "text": "*Hello!*" }
    },
    {
      "type": "actions",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Click me" },
          "action_id": "my_button",
          "value": "button_value"
        }
      ]
    }
  ]
}
```

### Handle Button Click
When a user clicks a button, the agent receives a system event:
```
Slack button clicked: actionId=my_button value=button_value user=U123
```

## Configuration

### Required: User Token for Search
Add to `openclaw.json`:
```json
{
  "channels": {
    "slack": {
      "userToken": "xoxp-...",
      "userTokenReadOnly": true
    }
  }
}
```

### Enable Search Action
Search is enabled by default. To explicitly enable:
```json
{
  "channels": {
    "slack": {
      "actions": {
        "search": true
      }
    }
  }
}
```

## Testing

All features tested and working:
- ✅ Search returns results with correct pagination
- ✅ Block Kit messages render buttons correctly
- ✅ Button clicks acknowledged without warning icon
- ✅ Ephemeral confirmation sent to user
- ✅ System events enqueued for agent handling

## Files Changed
- `src/slack/actions.ts` - Search function and types
- `src/slack/send.ts` - Block Kit support in message sending
- `src/agents/tools/slack-actions.ts` - Action handlers for search and blocks
- `src/agents/tools/slack-actions.test.ts` - Tests for new features
- `src/channels/plugins/slack.actions.ts` - Channel plugin wiring
- `src/slack/monitor/events/interactions.ts` - NEW: Interaction handler
- `src/slack/monitor/events.ts` - Register interaction handler

## Backwards Compatibility
- All changes are additive
- Existing Slack functionality unchanged
- New features opt-in via parameters

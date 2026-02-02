# Slack Features Implementation Plan

## Branch: `feat/slack-search-and-blocks`

## Overview
Implement two missing Slack features:
1. **Search** - Message search using Slack's `search.messages` API
2. **Block Kit support** - Allow sending interactive buttons/components via Block Kit JSON

---

## 1. Search Implementation

### Files to Modify:

#### `src/slack/actions.ts`
- Add `searchSlackMessages()` function
- Uses `client.search.messages()` from Slack Web API
- Requires user token (bot tokens can't search)

#### `src/agents/tools/slack-actions.ts`
- Add `"searchMessages"` action handler in `handleSlackAction()`
- Parameters: `query` (required), `sort`, `sortDir`, `count`

#### `src/channels/plugins/slack.actions.ts`
- Add `"search"` to `listActions()` return value
- Add `"search"` case in `handleAction()` method

### API Reference:
```typescript
// Slack search.messages API
client.search.messages({
  query: "from:@user in:#channel keyword",
  sort: "timestamp", // or "score"
  sort_dir: "desc",  // or "asc"
  count: 20          // max 100
})
```

---

## 2. Block Kit / Buttons Implementation

### Files to Modify:

#### `src/slack/send.ts`
- Modify `sendMessageSlack()` to accept optional `blocks` parameter
- Pass `blocks` to `client.chat.postMessage()` when provided
- Blocks override text formatting (text becomes fallback)

#### `src/slack/actions.ts`
- Update `sendSlackMessage()` to pass through `blocks` option

#### `src/agents/tools/slack-actions.ts`
- Add `blocks` parameter to `sendMessage` action handler

#### `src/channels/plugins/slack.actions.ts`
- Add `blocks` parameter reading in `send` action handler
- Pass through to `handleSlackAction()`

### API Reference:
```typescript
// Block Kit example
const blocks = [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: "Hello from OpenClaw!"
    }
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "Click me" },
        action_id: "button_1",
        value: "clicked"
      }
    ]
  }
];

client.chat.postMessage({
  channel: "C123",
  text: "Fallback text",
  blocks: blocks
});
```

---

## 3. Testing

### Unit Tests:
- `src/agents/tools/slack-actions.test.ts` - Add tests for search and blocks
- `src/slack/actions.ts` - Mock search API calls

### Manual Testing:
1. Configure user token in OpenClaw config
2. Test search: `message action=search channel=slack query="test"`
3. Test blocks: Send message with Block Kit JSON

---

## 4. Documentation Updates

Update docs to reflect new capabilities:
- `docs/providers/slack.md` - Add search and Block Kit sections
- `skills/slack/SKILL.md` - Update action list

---

## Implementation Order:

1. ✅ Create branch
2. 🔄 Implement search in `src/slack/actions.ts`
3. 🔄 Wire search through action handlers
4. 🔄 Implement blocks in `src/slack/send.ts`
5. 🔄 Wire blocks through action handlers
6. 🔄 Add tests
7. 🔄 Manual testing
8. 🔄 Update docs
9. 🔄 Create PR

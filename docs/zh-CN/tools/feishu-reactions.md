# Feishu Reaction Tool

The Feishu reaction tool allows agents to add, remove, and list emoji reactions on messages.

## Setup

Enable the reaction tool in your Feishu config:

```json
{
  "channels": {
    "feishu": {
      "tools": {
        "reaction": true  // Enabled by default
      }
    }
  }
}
```

## Usage

### Add a reaction

```json
{
  "action": "add",
  "message_id": "msg_xxxxxx",
  "emoji_type": "THUMBSUP"
}
```

### Remove a reaction

```json
{
  "action": "remove",
  "message_id": "msg_xxxxxx",
  "reaction_id": "react_xxxxxx"
}
```

### List reactions

```json
{
  "action": "list",
  "message_id": "msg_xxxxxx"
}
```

## Available Emoji Types

Common emoji types:

- `THUMBSUP` 👍
- `THUMBSDOWN` 👎
- `HEART` ❤️
- `SMILE` 😊
- `GRINNING` 😀
- `LAUGHING` 😂
- `CRY` 😢
- `ANGRY` 😠
- `SURPRISED` 😲
- `THINKING` 🤔
- `CLAP` 👏
- `OK` 👌
- `FIST` ✊
- `PRAY` 🙏
- `FIRE` 🔥
- `PARTY` 🎉
- `CHECK` ✅
- `CROSS` ❌
- `QUESTION` ❓
- `EXCLAMATION` ❗

For a complete list, see the [Feishu emoji documentation](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce).

## Examples

### React to a message with thumbs up

```typescript
await feishu_reaction({
  action: "add",
  message_id: "msg_123",
  emoji_type: "THUMBSUP"
});
```

### Check all reactions on a message

```typescript
const result = await feishu_reaction({
  action: "list",
  message_id: "msg_123"
});
// Returns: { reactions: [{ reactionId, emojiType, operatorType, operatorId }] }
```

### Remove a specific reaction

```typescript
await feishu_reaction({
  action: "remove",
  message_id: "msg_123",
  reaction_id: "react_456"
});
```

## Error Handling

The tool returns errors in the following cases:

- Missing required `emoji_type` for add action
- Missing required `reaction_id` for remove action
- Invalid action type
- API failures (network, auth, etc.)

Example error response:

```json
{
  "error": "emoji_type is required for add action"
}
```

# Feishu Emoji Reference

Complete reference for Feishu/Lark emoji types supported by the reaction API.

## Common Emoji Types

### Positive Reactions

| Emoji Type | Display | Description |
|------------|---------|-------------|
| `THUMBSUP` | 👍 | Thumbs up / Like |
| `HEART` | ❤️ | Heart / Love |
| `SMILE` | 😊 | Smile |
| `GRINNING` | 😀 | Grinning face |
| `LAUGHING` | 😂 | Laughing with tears |
| `CLAP` | 👏 | Clapping hands |
| `OK` | 👌 | OK hand sign |
| `PRAY` | 🙏 | Praying hands |
| `FIRE` | 🔥 | Fire |
| `PARTY` | 🎉 | Party popper |
| `CHECK` | ✅ | Check mark |

### Negative Reactions

| Emoji Type | Display | Description |
|------------|---------|-------------|
| `THUMBSDOWN` | 👎 | Thumbs down |
| `CRY` | 😢 | Crying face |
| `ANGRY` | 😠 | Angry face |
| `CROSS` | ❌ | Cross mark |

### Neutral Reactions

| Emoji Type | Display | Description |
|------------|---------|-------------|
| `SURPRISED` | 😲 | Surprised face |
| `THINKING` | 🤔 | Thinking face |
| `FIST` | ✊ | Raised fist |
| `QUESTION` | ❓ | Question mark |
| `EXCLAMATION` | ❗ | Exclamation mark |

## Usage Examples

### Add Multiple Reactions

```typescript
// Add thumbs up
await feishu_reaction({
  action: "add",
  message_id: "msg_123",
  emoji_type: "THUMBSUP"
});

// Add heart
await feishu_reaction({
  action: "add",
  message_id: "msg_123",
  emoji_type: "HEART"
});

// Add fire
await feishu_reaction({
  action: "add",
  message_id: "msg_123",
  emoji_type: "FIRE"
});
```

### List All Reactions

```typescript
const result = await feishu_reaction({
  action: "list",
  message_id: "msg_123"
});

// Returns:
// {
//   reactions: [
//     { reactionId: "r1", emojiType: "THUMBSUP", operatorType: "user", operatorId: "u1" },
//     { reactionId: "r2", emojiType: "HEART", operatorType: "app", operatorId: "bot_id" }
//   ]
// }
```

### Remove a Reaction

```typescript
// First list to get reaction_id
const reactions = await feishu_reaction({
  action: "list",
  message_id: "msg_123"
});

// Remove specific reaction
await feishu_reaction({
  action: "remove",
  message_id: "msg_123",
  reaction_id: reactions.reactions[0].reactionId
});
```

## Complete Emoji List

Feishu supports 50+ emoji types. Here's the complete list:

### Faces & Emotions

```
SMILE, GRINNING, LAUGHING, JOY, SURPRISED, THINKING, CRY, ANGRY, 
SAD, WORRIED, EMBARRASSED, COOL, SLEEPY, DIZZY, YUMMY, KISSY, 
CONFIDENT, RELAXED, STAR_STRUCK, PARTY
```

### Gestures

```
THUMBSUP, THUMBSDOWN, CLAP, OK, FIST, PRAY, WAVE, YES, NO,
HEART, BROKEN_HEART, VICTORY, ROSE, WILTED_FLOWER
```

### Symbols

```
CHECK, CROSS, QUESTION, EXCLAMATION, DOUBLE_EXCLAMATION, 
100, FIRE, SPARKLES, STAR, MOON, SUN, ZAP, CHRISTMAS_TREE, 
GIFT, TADA, MEDAL, TROPHY
```

## API Reference

For the complete official emoji list, see:
- [Feishu Emoji Types Documentation](https://open.feishu.cn/document/server-docs/im-v1/message-reaction/emojis-introduce)

## Notes

- Emoji types are case-sensitive (use uppercase)
- Some emoji may display differently depending on the user's platform
- The bot can only add reactions that are enabled for the Feishu app

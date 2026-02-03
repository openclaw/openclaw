---
name: x-actions
description: Perform X (Twitter) actions like following users, liking tweets, replying to tweets, and sending DMs. Use when the user wants to interact with X/Twitter - follow/unfollow users, like/unlike tweets, reply/comment on tweets, send direct messages, or check X account info.
---

# X (Twitter) Actions

This skill enables X/Twitter interactions through the message tool.

> **IMPORTANT**: For X/Twitter actions, ALWAYS use the `message` tool with X-specific actions listed below. Do NOT use the `browser` tool for X operations - the message tool uses configured API credentials and is faster, more reliable, and works without browser automation.

## Available Actions

| Action | Description | Example |
|--------|-------------|---------|
| `x-follow` | Follow a user | `message({ action: "x-follow", target: "@elonmusk" })` |
| `x-unfollow` | Unfollow a user | `message({ action: "x-unfollow", target: "@elonmusk" })` |
| `x-like` | Like a tweet | `message({ action: "x-like", target: "https://x.com/user/status/123" })` |
| `x-unlike` | Unlike a tweet | `message({ action: "x-unlike", target: "1234567890" })` |
| `x-reply` | Reply to / comment on a tweet | `message({ action: "x-reply", target: "https://x.com/user/status/123", message: "Great post!" })` |
| `x-dm` | Send direct message | `message({ action: "x-dm", target: "@user", message: "Hello!" })` |

## Usage

### Follow a User

```typescript
// By username (with or without @)
message({ action: "x-follow", target: "@elonmusk" })
message({ action: "x-follow", target: "elonmusk" })

// By user ID
message({ action: "x-follow", target: "44196397" })
```

### Like a Tweet

```typescript
// By URL
message({ action: "x-like", target: "https://x.com/elonmusk/status/1234567890" })
message({ action: "x-like", target: "https://twitter.com/user/status/1234567890" })

// By tweet ID
message({ action: "x-like", target: "1234567890" })
```

### Reply to / Comment on a Tweet

```typescript
// By URL
message({
  action: "x-reply",
  target: "https://x.com/user/status/1234567890",
  message: "Your reply text here (max 280 chars)",
})

// By tweet ID
message({ action: "x-reply", target: "1234567890", message: "Comment content" })
```

### Send Direct Message

```typescript
message({
  action: "x-dm",
  target: "@username",
  message: "Your message here"
})
```

## Natural Language Mapping

When users ask to interact with X/Twitter, map their requests:

| User Request (Chinese) | Action |
|------------------------|--------|
| 关注 @xxx / 帮我关注一下 xxx | `x-follow` |
| 取消关注 / 取关 @xxx | `x-unfollow` |
| 点赞这条推文 / 给这条推点个赞 | `x-like` |
| 取消点赞 | `x-unlike` |
| 评论这条推 / 回复这条推文 / 根据内容做评论 | `x-reply` |
| 发私信给 @xxx / 私信 @xxx | `x-dm` |

| User Request (English) | Action |
|------------------------|--------|
| Follow @xxx | `x-follow` |
| Unfollow @xxx | `x-unfollow` |
| Like this tweet | `x-like` |
| Unlike this tweet | `x-unlike` |
| Reply to this tweet / Comment on this tweet | `x-reply` |
| DM @xxx / Send a message to @xxx | `x-dm` |

## Parameters

### Target Formats

- **Username**: `@elonmusk` or `elonmusk`
- **User ID**: `44196397`
- **Tweet URL**: `https://x.com/user/status/123` or `https://twitter.com/user/status/123`
- **Tweet ID**: `1234567890123456789`

### Optional Parameters

- `accountId`: Specify which X account to use (if multiple configured)

## Error Handling

Check result for success:

```typescript
const result = message({ action: "x-follow", target: "@user" });
// result.ok: boolean
// result.error: string (if failed)
// result.following: boolean (for follow/unfollow)
// result.liked: boolean (for like/unlike)
```

## Requirements

X account must be configured in `channels.x` with:
- `consumerKey`
- `consumerSecret`
- `accessToken`
- `accessTokenSecret`

## Permission control

Two separate allowlists; do not reuse one for the other.

- **Mention allowlist (X)** – who can mention the bot and get a reply:
  - **X**: `channels.x.allowFrom` – X user IDs who can mention the bot (mention → reply). Server config only.
  - **Feishu**: `channels.feishu.allowFrom` – who can send DMs/messages (controls mention/chat access). Server config only.

- **Proactive X actions allowlist** – who can trigger follow/like/reply/dm (auto-operations):
  - **X**: `channels.x.actionsAllowFrom` – X user IDs who can trigger x-follow, x-like, x-reply, x-dm when they mention the bot. Do not reuse `allowFrom`.
  - **Feishu**: `channels.feishu.xActionsAllowFrom` – Feishu user IDs who can trigger X actions from Feishu. Do not reuse `allowFrom`.

- **Reply restriction when triggered from X**: When the user mentioned the bot on X, x-reply is only allowed to that user's tweets (target tweet author must match the mentioning user).

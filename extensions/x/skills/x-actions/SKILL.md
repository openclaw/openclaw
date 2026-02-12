---
name: x-actions
description: Perform X (Twitter) actions like following users, liking tweets, reposting tweets, replying to tweets, sending DMs, and querying tweets. Use when the user wants to interact with X/Twitter - follow/unfollow users, like/unlike tweets, repost/unrepost tweets, reply/comment on tweets, send direct messages, search/view tweets or user timelines, or check X account info.
---

# X (Twitter) Actions

This skill enables X/Twitter interactions through two complementary tool sets:

- **Write actions** (follow, like, repost, reply, DM): use the `message` tool with X-specific actions.
- **Read/query actions** (search tweets, view user timeline, get tweet details): use `qveris_search` + `qveris_execute`.

> **IMPORTANT**: For X/Twitter write actions, ALWAYS use the `message` tool with X-specific actions listed below. For searching/querying tweets and user timelines, use QVeris tools. Do NOT use the `browser` tool for X operations - the API-based tools are faster, more reliable, and work without browser automation.

## Write Actions (message tool)

| Action       | Description                   | Example                                                                                           |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `x-follow`   | Follow a user                 | `message({ action: "x-follow", target: "@elonmusk" })`                                            |
| `x-unfollow` | Unfollow a user               | `message({ action: "x-unfollow", target: "@elonmusk" })`                                          |
| `x-like`     | Like a tweet                  | `message({ action: "x-like", target: "https://x.com/user/status/123" })`                          |
| `x-unlike`   | Unlike a tweet                | `message({ action: "x-unlike", target: "1234567890" })`                                           |
| `x-repost`   | Repost (retweet) a tweet      | `message({ action: "x-repost", target: "https://x.com/user/status/123" })`                        |
| `x-unrepost` | Undo repost (unretweet)       | `message({ action: "x-unrepost", target: "1234567890" })`                                         |
| `x-reply`    | Reply to / comment on a tweet | `message({ action: "x-reply", target: "https://x.com/user/status/123", message: "Great post!" })` |
| `x-dm`       | Send direct message           | `message({ action: "x-dm", target: "@user", message: "Hello!" })`                                 |

## Read/Query Actions (QVeris tools)

When users want to **search tweets, view a user's timeline, or get tweet details**, use QVeris:

### Step 1: Search for the right tool

```typescript
qveris_search({ query: "get twitter user tweets timeline" });
// or
qveris_search({ query: "search twitter tweets by keyword" });
```

### Step 2: Execute the tool with parameters

```typescript
qveris_execute({
  tool_id: "<tool_id from search>",
  search_id: "<search_id from search>",
  params_to_tool: '{"username": "elonmusk"}',
});
```

### Common query patterns

| Need                        | QVeris search query                   |
| --------------------------- | ------------------------------------- |
| View a user's recent tweets | `"get twitter user tweets timeline"`  |
| Search tweets by keyword    | `"search twitter tweets by keyword"`  |
| Get tweet details/metrics   | `"get twitter tweet details metrics"` |
| Get user profile info       | `"get twitter user profile info"`     |

## Combined Workflow Examples

### Example: Find and comment on a user's hottest tweet

User: "查看 elonmusk 今天发布的推文，找一条最热的，根据内容进行评论"

1. **Query**: Use QVeris to fetch the user's recent tweets
2. **Analyze**: Review the returned tweets, pick the one with the most engagement (likes, retweets, replies)
3. **Act**: Use `x-reply` to comment on the selected tweet

```typescript
// Step 1: Find tweet query tool
qveris_search({ query: "get twitter user tweets timeline" });

// Step 2: Fetch tweets
qveris_execute({
  tool_id: "<tool_id>",
  search_id: "<search_id>",
  params_to_tool: '{"username": "elonmusk"}',
});

// Step 3: After analyzing results, reply to the hottest tweet
message({
  action: "x-reply",
  target: "https://x.com/elonmusk/status/<tweet_id>",
  message: "Your thoughtful comment here (max 280 chars)",
});
```

### Example: Search topic and like the best tweets

User: "搜索关于 AI 的热门推文，点赞前三条"

1. **Query**: Use QVeris to search tweets about AI
2. **Analyze**: Sort by engagement metrics
3. **Act**: Use `x-like` on the top 3 tweets

### Example: Monitor and follow key users

User: "找几个经常发 Web3 内容的博主，帮我关注"

1. **Query**: Use QVeris to search for Web3-related tweets/users
2. **Analyze**: Identify active users from the results
3. **Act**: Use `x-follow` for each identified user

## Write Action Usage Details

### Follow a User

```typescript
// By username (with or without @)
message({ action: "x-follow", target: "@elonmusk" });
message({ action: "x-follow", target: "elonmusk" });

// By user ID
message({ action: "x-follow", target: "44196397" });
```

### Like a Tweet

```typescript
// By URL
message({ action: "x-like", target: "https://x.com/elonmusk/status/1234567890" });
message({ action: "x-like", target: "https://twitter.com/user/status/1234567890" });

// By tweet ID
message({ action: "x-like", target: "1234567890" });
```

### Repost (Retweet) a Tweet

```typescript
// By URL
message({ action: "x-repost", target: "https://x.com/elonmusk/status/1234567890" });
message({ action: "x-repost", target: "https://twitter.com/user/status/1234567890" });

// By tweet ID
message({ action: "x-repost", target: "1234567890" });
```

### Undo Repost (Unretweet)

```typescript
// By URL
message({ action: "x-unrepost", target: "https://x.com/user/status/1234567890" });

// By tweet ID
message({ action: "x-unrepost", target: "1234567890" });
```

### Reply to / Comment on a Tweet

```typescript
// By URL
message({
  action: "x-reply",
  target: "https://x.com/user/status/1234567890",
  message: "Your reply text here (max 280 chars)",
});

// By tweet ID
message({ action: "x-reply", target: "1234567890", message: "Comment content" });
```

### Send Direct Message

```typescript
message({
  action: "x-dm",
  target: "@username",
  message: "Your message here",
});
```

## Natural Language Mapping

When users ask to interact with X/Twitter, map their requests:

| User Request (Chinese)                     | Tool    | Action                  |
| ------------------------------------------ | ------- | ----------------------- |
| 查看 @xxx 的推文 / 看看 xxx 最近发了什么   | QVeris  | query timeline          |
| 搜索关于 xxx 的推文 / 找 xxx 相关的推      | QVeris  | search tweets           |
| 找最热门的推文 / 哪条推最火                | QVeris  | query + sort by metrics |
| 关注 @xxx / 帮我关注一下 xxx               | message | `x-follow`              |
| 取消关注 / 取关 @xxx                       | message | `x-unfollow`            |
| 点赞这条推文 / 给这条推点个赞              | message | `x-like`                |
| 取消点赞                                   | message | `x-unlike`              |
| 转推 / 转发这条推文                        | message | `x-repost`              |
| 取消转推 / 取消转发                        | message | `x-unrepost`            |
| 评论这条推 / 回复这条推文 / 根据内容做评论 | message | `x-reply`               |
| 发私信给 @xxx / 私信 @xxx                  | message | `x-dm`                  |

| User Request (English)                                | Tool    | Action                  |
| ----------------------------------------------------- | ------- | ----------------------- |
| Show me @xxx's tweets / What did xxx post recently    | QVeris  | query timeline          |
| Search tweets about xxx / Find tweets on xxx          | QVeris  | search tweets           |
| Find the most popular tweet / Which tweet is trending | QVeris  | query + sort by metrics |
| Follow @xxx                                           | message | `x-follow`              |
| Unfollow @xxx                                         | message | `x-unfollow`            |
| Like this tweet                                       | message | `x-like`                |
| Unlike this tweet                                     | message | `x-unlike`              |
| Repost this tweet / Retweet this                      | message | `x-repost`              |
| Undo repost / Unretweet                               | message | `x-unrepost`            |
| Reply to this tweet / Comment on this tweet           | message | `x-reply`               |
| DM @xxx / Send a message to @xxx                      | message | `x-dm`                  |

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
// result.retweeted: boolean (for repost/unrepost)
```

## Requirements

X account must be configured in `channels.x` with:

- `consumerKey`
- `consumerSecret`
- `accessToken`
- `accessTokenSecret`

QVeris tools must be enabled with a valid API key (`tools.qveris.apiKey` or `QVERIS_API_KEY` env var).

## Permission control

Two separate allowlists; do not reuse one for the other.

- **Mention allowlist (X)** -- who can mention the bot and get a reply:
  - **X**: `channels.x.allowFrom` -- X user IDs who can mention the bot (mention -> reply). Server config only.
  - **Feishu**: `channels.feishu.allowFrom` -- who can send DMs/messages (controls mention/chat access). Server config only.

- **Proactive X actions allowlist** -- who can trigger follow/like/repost/reply/dm (auto-operations):
  - **X**: `channels.x.actionsAllowFrom` -- X user IDs who can trigger x-follow, x-like, x-reply, x-dm when they mention the bot. Do not reuse `allowFrom`.
  - **Feishu**: `channels.feishu.xActionsAllowFrom` -- Feishu user IDs who can trigger X actions from Feishu. Do not reuse `allowFrom`.

- **Reply restriction when triggered from X**: When the user mentioned the bot on X, x-reply is only allowed to that user's tweets (target tweet author must match the mentioning user).

- **QVeris query actions**: No additional permission required beyond normal channel access. QVeris tools use their own API key for authentication.

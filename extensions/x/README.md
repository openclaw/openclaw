# @moltbot/x

X (Twitter) channel plugin for Moltbot.

## Features

- Monitor mentions of your X account
- Automatically reply to tweets mentioning you
- Configurable polling interval
- Cost-efficient: uses `since_id` to fetch only new mentions
- Access control via user ID allowlist

## Install

```bash
moltbot plugins install @moltbot/x
```

Or from local checkout:

```bash
moltbot plugins install ./extensions/x
```

## Setup

1. Go to [X Developer Portal](https://developer.x.com/en/portal/dashboard)
2. Create a project and app (or use existing)
3. Generate OAuth 1.0a credentials:
   - Consumer Key (API Key)
   - Consumer Secret (API Secret)
   - Access Token
   - Access Token Secret
4. Configure in moltbot config

## Config

Minimal config:

```json5
{
  channels: {
    x: {
      enabled: true,
      consumerKey: "your_api_key",
      consumerSecret: "your_api_secret",
      accessToken: "your_access_token",
      accessTokenSecret: "your_access_token_secret",
    },
  },
}
```

Full config with options:

```json5
{
  channels: {
    x: {
      enabled: true,
      consumerKey: "your_api_key",
      consumerSecret: "your_api_secret",
      accessToken: "your_access_token",
      accessTokenSecret: "your_access_token_secret",
      pollIntervalSeconds: 60, // How often to check for mentions (min: 15)
      allowFrom: ["123456789"], // Optional: only respond to these user IDs
    },
  },
}
```

## Multi-account

```json5
{
  channels: {
    x: {
      accounts: {
        main: {
          consumerKey: "...",
          consumerSecret: "...",
          accessToken: "...",
          accessTokenSecret: "...",
        },
        secondary: {
          consumerKey: "...",
          consumerSecret: "...",
          accessToken: "...",
          accessTokenSecret: "...",
        },
      },
    },
  },
}
```

## How it works

1. The plugin polls `GET /2/users/:id/mentions` at the configured interval
2. Uses `since_id` parameter to fetch only new mentions (cost-efficient)
3. Processes each mention through the agent
4. Replies via `POST /2/tweets` with `reply.in_reply_to_tweet_id`
5. Long replies are automatically chunked into tweet threads (280 char limit)

## Rate Limits

X API v2 rate limits (user context):

- Mentions timeline: 180 requests / 15 minutes
- Post tweet: 200 requests / 15 minutes

With default 60s polling, you'll use ~15 requests per 15 minutes.

## Troubleshooting

```bash
moltbot doctor
moltbot channels status --probe
```

### Common issues

- **401 Unauthorized**: Check your credentials are correct
- **403 Forbidden**: Your app may not have write permissions
- **429 Too Many Requests**: Reduce poll interval or wait for rate limit reset

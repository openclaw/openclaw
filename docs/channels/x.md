---
summary: "X (Twitter) bot configuration and setup"
read_when:
  - Setting up X/Twitter integration for Moltbot
---

# X / Twitter (plugin)

X (Twitter) integration via API v2. Moltbot monitors mentions of your X account and replies automatically.

## Plugin required

X ships as a plugin and is not bundled with the core install.

Install via CLI:

```bash
moltbot plugins install @moltbot/x
```

Local checkout:

```bash
moltbot plugins install ./extensions/x
```

## Quick setup

1. Go to [X Developer Portal](https://developer.x.com/en/portal/dashboard)
2. Create a project and app
3. Generate OAuth 1.0a credentials (Keys and Tokens tab)
4. Add to config:

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

5. Start the gateway

## What it does

- Polls your mentions timeline for new tweets @mentioning you
- Routes each mention to your agent
- Replies to the tweet with the agent's response
- Auto-chunks long responses into tweet threads

## Configuration

| Option                | Description                                 | Default   |
| --------------------- | ------------------------------------------- | --------- |
| `consumerKey`         | API Key from X Developer Portal             | required  |
| `consumerSecret`      | API Secret from X Developer Portal          | required  |
| `accessToken`         | Access Token from X Developer Portal        | required  |
| `accessTokenSecret`   | Access Token Secret from X Developer Portal | required  |
| `enabled`             | Enable/disable the channel                  | `true`    |
| `pollIntervalSeconds` | How often to check for mentions (min: 15)   | `60`      |
| `allowFrom`           | User ID allowlist (optional)                | all users |

## Access control

Restrict who can trigger your bot:

```json5
{
  channels: {
    x: {
      allowFrom: ["123456789", "987654321"],
    },
  },
}
```

Find your X user ID: Search "twitter user id lookup" or use the API.

## Cost optimization

The plugin uses X API's `since_id` parameter to fetch only new mentions since the last poll. This minimizes API usage and costs.

State is persisted to disk, so the bot remembers where it left off after restarts.

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
          pollIntervalSeconds: 30,
        },
        alerts: {
          consumerKey: "...",
          consumerSecret: "...",
          accessToken: "...",
          accessTokenSecret: "...",
          pollIntervalSeconds: 120,
        },
      },
    },
  },
}
```

## Limits

- **280 characters** per tweet (auto-chunked into threads)
- **Polling-based**: Not real-time; uses configured interval
- **No media upload**: Text replies only (for now)

## Rate limits

X API v2 (user context):

- Mentions: 180 requests / 15 min
- Post tweet: 200 requests / 15 min

Default 60s poll = ~15 requests / 15 min (well within limits).

## Troubleshooting

```bash
moltbot doctor
moltbot channels status --probe
```

### 401 Unauthorized

Check credentials are correct and not expired.

### 403 Forbidden

Your X app may not have write permissions. Check app settings in Developer Portal.

### 429 Too Many Requests

Rate limited. Increase `pollIntervalSeconds` or wait.

### No replies appearing

1. Check the bot is running: `moltbot channels status`
2. Check logs for errors
3. Verify `allowFrom` isn't blocking the sender

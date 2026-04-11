# @openclaw/bluesky

Bluesky DM channel plugin for OpenClaw using the AT Protocol chat API.

## Overview

This extension adds Bluesky as a messaging channel to OpenClaw. It enables your agent to:

- Receive direct messages from Bluesky users via `chat.bsky.*` lexicons
- Send replies back via the Bluesky chat API
- Support slash command pass-through
- Run multiple named accounts from a single gateway

## Installation

```bash
openclaw plugins install @openclaw/bluesky
```

## Quick Setup

### Interactive setup (recommended)

After installing the plugin, run the interactive setup wizard:

```bash
openclaw configure bluesky
```

This prompts for your handle and app password, detects existing env vars, and
writes the config for you. You can also reach it via `openclaw onboard` if
Bluesky has not been configured yet.

### Manual setup

1. Create a Bluesky App Password at **Settings → Privacy and Security → App Passwords**
   (do **not** use your main account password)

2. Set environment variables:

   ```bash
   export BLUESKY_HANDLE="yourbot.bsky.social"
   export BLUESKY_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
   ```

3. Bind the channel to an agent in your config:

   ```json
   {
     "bindings": [{ "agentId": "your-agent", "channel": "bluesky" }]
   }
   ```

4. Restart the gateway

## Configuration

### Environment Variables

| Variable               | Description                                                  |
| ---------------------- | ------------------------------------------------------------ |
| `BLUESKY_HANDLE`       | Bot account handle (e.g. `yourbot.bsky.social`)              |
| `BLUESKY_APP_PASSWORD` | App password generated from Bluesky account settings         |
| `BLUESKY_PDS_URL`      | Personal Data Server URL — defaults to `https://bsky.social` |

### Config File Options

All options can also be set in `openclaw.json` under `channels.bluesky`:

| Key           | Type    | Default                 | Description                             |
| ------------- | ------- | ----------------------- | --------------------------------------- |
| `handle`      | string  | `$BLUESKY_HANDLE`       | Bot account handle                      |
| `appPassword` | string  | `$BLUESKY_APP_PASSWORD` | App password (supports SecretRef)       |
| `pdsUrl`      | string  | `https://bsky.social`   | Personal Data Server URL                |
| `enabled`     | boolean | `true`                  | Enable or disable the channel           |
| `accounts`    | object  | —                       | Named accounts for multi-account setups |

### Single Account (env vars)

```bash
export BLUESKY_HANDLE="yourbot.bsky.social"
export BLUESKY_APP_PASSWORD="xxxx-xxxx-xxxx-xxxx"
```

### Single Account (config file)

```json
{
  "channels": {
    "bluesky": {
      "handle": "yourbot.bsky.social",
      "appPassword": "xxxx-xxxx-xxxx-xxxx"
    }
  }
}
```

### Custom PDS (self-hosted)

```json
{
  "channels": {
    "bluesky": {
      "handle": "yourbot.example.com",
      "appPassword": "xxxx-xxxx-xxxx-xxxx",
      "pdsUrl": "https://pds.example.com"
    }
  }
}
```

### Multiple Accounts

Use `accounts` to run separate bots for different agents from the same gateway:

```json
{
  "channels": {
    "bluesky": {
      "accounts": {
        "sales-bot": {
          "handle": "sales.bsky.social",
          "appPassword": "xxxx-xxxx-xxxx-xxxx"
        },
        "support-bot": {
          "handle": "support.bsky.social",
          "appPassword": "yyyy-yyyy-yyyy-yyyy"
        }
      }
    }
  },
  "bindings": [
    { "agentId": "sales-agent", "channel": "bluesky", "accountId": "sales-bot" },
    { "agentId": "support-agent", "channel": "bluesky", "accountId": "support-bot" }
  ]
}
```

## How It Works

### Authentication

The plugin authenticates with the Bluesky PDS using your handle and app password to create an
XRPC session. For chat API calls, it then acquires short-lived service auth tokens scoped to each
`chat.bsky.*` lexicon method (tokens are cached for 25 minutes and automatically refreshed).
On a 401 response the cached token is evicted and the request is retried once.

### Polling

The plugin uses an adaptive polling loop with exponential backoff:

- **2 seconds** after a new message arrives (to catch quick replies)
- Backs off by **1.5×** per idle cycle up to a maximum of **90 seconds**
- Resets to 2 seconds immediately on any new activity

### Slash Commands

Inbound messages starting with `/` are forwarded to the agent as slash commands.

## Troubleshooting

### `Bluesky: not configured` in `openclaw doctor`

- Check that `BLUESKY_HANDLE` and `BLUESKY_APP_PASSWORD` are set, or that a named account is
  configured under `channels.bluesky.accounts`
- When using named accounts without top-level credentials, ensure the account is bound to an agent

### Bot not receiving messages

1. Verify the app password is correct — generate a new one if unsure
2. Confirm the handle includes the domain (e.g. `yourbot.bsky.social`, not just `yourbot`)
3. Check that `enabled` is not set to `false`
4. Verify the channel is bound to an agent in `bindings`

### `401` errors at startup

- The app password may have been revoked; generate a new one from Bluesky settings
- Custom PDS users: verify `pdsUrl` is correct and reachable

## Security Notes

- Use App Passwords, never your main Bluesky account password
- App passwords can be revoked individually from Bluesky settings without affecting your account
- Credentials are never logged
- Use environment variables or SecretRef config values; avoid committing credentials to config files

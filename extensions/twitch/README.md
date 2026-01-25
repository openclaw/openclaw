# @clawdbot/twitch

Twitch chat plugin for Clawdbot.

## Install (local checkout)

```bash
clawdbot plugins install ./extensions/twitch
```

## Install (npm)

```bash
clawdbot plugins install @clawdbot/twitch
```

Onboarding: select Twitch and confirm the install prompt to fetch the plugin automatically.

## Config

Minimal config:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      accounts: {
        default: {
          username: "clawdbot",
          token: "oauth:abc123...",
          clientId: "your_client_id_here",
          channel: "vevisk"
        }
      }
    }
  }
}
```

## Setup

1. Create a Twitch application: [Twitch Developer Console](https://dev.twitch.tv/console)
2. Generate OAuth token: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Select scopes: `chat:read` and `chat:write`
3. Start the gateway

## Full documentation

See https://docs.clawd.bot/channels/twitch for:

- Token refresh setup
- Access control patterns
- Multi-account configuration
- Troubleshooting
- Capabilities & limits

# NanoClaw Setup Commands

Use these on the NanoClaw machine to align it with Cortex.

## Standard Path

Use this if `openclaw models status` on Nano already shows working Anthropic auth.

```powershell
openclaw models set anthropic/claude-sonnet-4-6
openclaw models fallbacks clear
openclaw models aliases remove sonnet
openclaw models aliases add sonnet anthropic/claude-sonnet-4-6
openclaw config unset agents.defaults.models.claude-cli/claude-3-5-sonnet-latest
openclaw config unset agents.defaults.models.claude-cli/claude-sonnet-4-6
openclaw config set channels.slack.channels.<NANO_CHANNEL_ID>.allow true --strict-json
openclaw config set channels.slack.channels.<NANO_CHANNEL_ID>.requireMention true --strict-json
openclaw config unset gateway.controlUi.allowInsecureAuth
openclaw gateway restart
```

Replace `<NANO_CHANNEL_ID>` with NanoClaw's real Slack channel ID.

## Alternate Path

Use this instead if Nano only has Claude Code CLI auth and not working Anthropic auth.

```powershell
openclaw models auth login --provider anthropic --method cli --set-default
```

## Verify

```powershell
openclaw models status
openclaw channels status
openclaw security audit
```

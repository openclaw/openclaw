# Working Memory

- 2026-04-08  NanoClaw alignment commands for the private computer / VS Code Codex session:

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

- 2026-04-08  NanoClaw decision rule: if `openclaw models status` on Nano already shows working Anthropic auth, keep the commands above. If Nano only has Claude Code CLI auth and not Anthropic auth, use this instead:

```powershell
openclaw models auth login --provider anthropic --method cli --set-default
```

- 2026-04-08  NanoClaw verification commands:

```powershell
openclaw models status
openclaw channels status
openclaw security audit
```

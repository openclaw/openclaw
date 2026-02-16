# MiniMax OAuth (SmartAgentNeo plugin)

OAuth provider plugin for **MiniMax** (OAuth).

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
smart-agent-neo plugins enable minimax-portal-auth
```

Restart the Gateway after enabling.

```bash
smart-agent-neo gateway restart
```

## Authenticate

```bash
smart-agent-neo models auth login --provider minimax-portal --set-default
```

You will be prompted to select an endpoint:

- **Global** - International users, optimized for overseas access (`api.minimax.io`)
- **China** - Optimized for users in China (`api.minimaxi.com`)

## Notes

- MiniMax OAuth uses a user-code login flow.
- Currently, OAuth login is supported only for the Coding plan

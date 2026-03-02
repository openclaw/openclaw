# MiniMax OAuth (OpenClaw plugin)

OAuth provider plugin for **MiniMax** (OAuth).

## Enable

Bundled plugins are disabled by default. Enable this one:

```bash
openclaw plugins enable minimax-portal-auth
```

Restart the Gateway after enabling.

```bash
openclaw gateway restart
```

## Authenticate

This plugin provides two separate providers for different regions:

### Global (International users)

```bash
openclaw models auth login --provider minimax-portal --set-default
```

Uses endpoint: `api.minimax.io`

### China (CN users)

```bash
openclaw models auth login --provider minimax-portal-cn --set-default
```

Uses endpoint: `api.minimaxi.com`

## Notes

- MiniMax OAuth uses a user-code login flow.
- Currently, OAuth login is supported only for the Coding plan
- Global and CN are now separate providers to avoid configuration conflicts when switching between regions
